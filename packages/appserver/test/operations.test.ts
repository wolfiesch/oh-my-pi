import { describe, expect, test } from "bun:test";
import {
	commandId,
	DEVICE_CAPABILITIES,
	decodeCommand,
	hostId,
	requestId,
	revision,
	sessionId,
	terminalId,
} from "@oh-my-pi/app-wire";
import {
	DesktopOperationDispatcher,
	type DesktopOperationsAuthority,
	type OperationContext,
	operationCapabilities,
	TerminalOwnerRegistry,
} from "../src/operations/dispatcher.ts";

const context: OperationContext = {
	hostId: hostId("host-1"),
	sessionId: sessionId("session-1"),
	deviceId: "device-1",
	connectionId: "connection-1",
	capabilities: new Set(DEVICE_CAPABILITIES),
	currentRevision: revision("r-1"),
	abortSignal: new AbortController().signal,
};
function command(name: string, args: Record<string, unknown> = {}, session = true, expectedRevision?: string) {
	const requiredRevision = ["files.write", "files.patch", "review.apply", "settings.write", "config.write"].includes(
		name,
	);
	return decodeCommand({
		v: "omp-app/1",
		type: "command",
		requestId: requestId(`request-${name}`),
		commandId: commandId(`command-${name}`),
		hostId: context.hostId,
		...(session ? { sessionId: context.sessionId } : {}),
		command: name,
		...(expectedRevision || requiredRevision ? { expectedRevision: expectedRevision ?? "r-1" } : {}),
		args,
	});
}
function authority(overrides: Partial<DesktopOperationsAuthority> = {}): DesktopOperationsAuthority {
	return {
		filesRead: async () => ({ content: "hello" }),
		filesList: async () => ({ entries: [] }),
		filesDiff: async () => ({ diff: "" }),
		filesWrite: async () => ({}),
		filesPatch: async () => ({}),
		reviewRead: async () => ({}),
		reviewApply: async () => ({}),
		bashRun: async () => ({}),
		termOpen: async () => ({ terminalId: "term-1" }),
		catalogGet: async () => ({ items: [] }),
		settingsRead: async () => ({ revision: "revision-settings", settings: {} }),
		brokerStatus: async () => ({ state: "local", generation: 1 }),
		settingsWrite: async () => ({}),
		configWrite: async () => ({}),
		previewLaunch: async () => ({}),
		previewState: async () => ({}),
		previewNavigate: async () => ({}),
		previewCapture: async () => ({ content: "" }),
		terminalInput: async () => {},
		terminalResize: async () => {},
		terminalClose: async () => {},
		...overrides,
	};
}

describe("desktop operation dispatcher", () => {
	test("routes operation families through typed authority", async () => {
		const dispatcher = new DesktopOperationDispatcher(authority());
		for (const name of [
			"files.read",
			"files.list",
			"files.diff",
			"files.write",
			"files.patch",
			"review.read",
			"review.apply",
			"bash.run",
			"catalog.get",
			"settings.read",
			"broker.status",
			"settings.write",
			"config.write",
			"preview.launch",
			"preview.state",
			"preview.navigate",
			"preview.capture",
		]) {
			const args = name.startsWith("files.")
				? {
						path: "src/a.txt",
						...(name === "files.write" ? { content: "x" } : {}),
						...(name === "files.patch" ? { patch: "x" } : {}),
					}
				: name.startsWith("review.")
					? { reviewId: "review-1" }
				: name.startsWith("preview.") && ["preview.launch", "preview.navigate"].includes(name)
					? { url: "http://localhost" }
					: name === "bash.run"
						? { command: "structured" }
						: {};
			const hostCommand = [
				"catalog.get",
				"settings.read",
				"broker.status",
				"settings.write",
				"config.write",
			].includes(name);
			await expect(
				dispatcher.dispatch(command(name, args, !hostCommand), {
					...context,
					...(hostCommand ? { sessionId: undefined } : {}),
				}),
			).resolves.toBeObject();
		}
	});
	test("rejects wrong host/scope, stale revision, abort, missing capability, and redacts authority errors", async () => {
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				filesRead: async () => {
					throw { code: "secret-provider", message: "token=bad" };
				},
			}),
		);
		await expect(
			dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, sessionId: sessionId("other") }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(dispatcher.dispatch(command("term.open", {}, true, "r-2"), context)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
		await expect(
			dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, abortSignal: AbortSignal.abort() }),
		).rejects.toMatchObject({ code: "ABORTED" });
		await expect(
			dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, capabilities: new Set() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(dispatcher.dispatch(command("files.read", { path: "a" }), context)).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
	});
	test("terminal lifecycle is all-or-nothing and late output is harmless", async () => {
		let closes = 0;
		let outputs = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async () => ({ terminalId: "term-1" }),
				terminalClose: async () => {
					closes++;
					if (closes === 1) throw new Error("close failed");
				},
				terminalOutput: () => {
					outputs++;
				},
			}),
		);
		expect(operationCapabilities({ termOpen: async () => ({ terminalId: "partial" }) })).not.toContain("term.open");
		const first = await dispatcher.dispatch(command("term.open"), context);
		const owner = {
			connectionId: context.connectionId,
			deviceId: context.deviceId,
			hostId: context.hostId,
			sessionId: context.sessionId!,
			terminalId: terminalId(String(first.terminalId)),
		};
		dispatcher.publishTerminalOutput(
			{
				v: "omp-app/1",
				type: "terminal.output",
				hostId: context.hostId,
				sessionId: context.sessionId,
				terminalId: owner.terminalId,
				cursor: { epoch: "e", seq: 1 },
				stream: "stdout",
				data: "x",
			},
			owner,
		);
		expect(outputs).toBe(1);
		await expect(
			dispatcher.disconnect(context.connectionId, { ...context, sessionId: context.sessionId! }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(closes).toBe(1);
		expect(() =>
			dispatcher.publishTerminalOutput(
				{
					v: "omp-app/1",
					type: "terminal.output",
					hostId: context.hostId,
					sessionId: context.sessionId,
					terminalId: owner.terminalId,
					cursor: { epoch: "e", seq: 2 },
					stream: "stdout",
					data: "late",
				},
				owner,
			),
		).not.toThrow();
	});
	test("authority receives unchanged revision and abort signal", async () => {
		let seen: OperationContext | undefined;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				filesWrite: async (_args, operationContext) => {
					seen = operationContext;
					return {};
				},
			}),
		);
		await dispatcher.dispatch(command("files.write", { path: "a", content: "x" }, true, "file-hash"), context);
		expect(String(seen?.expectedRevision)).toBe("file-hash");
		expect(seen && Object.isFrozen(seen.capabilities)).toBe(false);
	});
	test("terminal owner registry rejects wrong connection and releases on disconnect", () => {
		const registry = new TerminalOwnerRegistry();
		const owner = {
			connectionId: context.connectionId,
			deviceId: context.deviceId,
			hostId: context.hostId,
			sessionId: context.sessionId!,
			terminalId: terminalId("term-1"),
		};
		registry.claim(owner);
		expect(() => registry.assert({ ...owner, connectionId: "other" })).toThrow();
		registry.releaseConnection(context.connectionId);
		expect(() => registry.assert(owner)).toThrow();
	});
	test("disconnect closes every owned terminal and late callbacks remain harmless", async () => {
		let next = 0;
		let closes = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async () => ({ terminalId: `term-${++next}` }),
				terminalClose: async () => {
					closes++;
					if (closes === 1) throw new Error("close failed");
				},
			}),
		);
		await dispatcher.dispatch(command("term.open"), context);
		await dispatcher.dispatch(
			{
				...command("term.open"),
				commandId: commandId("command-term-open-2"),
				requestId: requestId("request-term-open-2"),
			},
			context,
		);
		await expect(
			dispatcher.disconnect(context.connectionId, { ...context, sessionId: context.sessionId! }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(closes).toBe(2);
	});
	test("abortSignal identity is passed unchanged to authority", async () => {
		let seen: AbortSignal | undefined;
		const signal = new AbortController().signal;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				filesRead: async (_args, operationContext) => {
					seen = operationContext.abortSignal;
					return { content: "ok" };
				},
			}),
		);
		await dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, abortSignal: signal });
		expect(seen).toBe(signal);
	});
});
