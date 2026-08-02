import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	OMP_AUTHORITY_BRIDGE_METHODS,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type OmpAuthorityBridgeMethod,
} from "../../appserver/src/omp-authority-bridge-contract";
import { SessionManager } from "../src/session/session-manager";

interface ResponseFrame {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string };
}
interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (reason?: unknown) => void;
}
interface BridgeChild {
	readonly stdin: { write(data: string): number | Promise<number>; end(): number | Promise<number> };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
}
interface EventWaiter {
	readonly predicate: (event: Record<string, unknown>) => boolean;
	readonly resolve: (event: Record<string, unknown>) => void;
}

class BridgeClient {
	readonly #pending = new Map<string, Deferred<ResponseFrame>>();
	readonly events: Record<string, unknown>[] = [];
	readonly ready = Promise.withResolvers<Record<string, unknown>>();
	readonly #eventWaiters: EventWaiter[] = [];
	#counter = 0;
	constructor(readonly child: BridgeChild) {
		void this.#read();
	}
	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of this.child.stdout as ReadableStream<Uint8Array>) {
			pending += decoder.decode(chunk, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const raw = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
				if (!raw) continue;
				const frame = JSON.parse(raw) as Record<string, unknown>;
				if (frame.type === "ready") this.ready.resolve(frame);
				else if (frame.type === "event") {
					this.events.push(frame);
					for (let index = this.#eventWaiters.length - 1; index >= 0; index--) {
						const waiter = this.#eventWaiters[index];
						if (!waiter.predicate(frame)) continue;
						this.#eventWaiters.splice(index, 1);
						waiter.resolve(frame);
					}
				} else if (frame.type === "response") {
					const gate = this.#pending.get(String(frame.id));
					if (gate) {
						this.#pending.delete(String(frame.id));
						gate.resolve(frame as unknown as ResponseFrame);
					}
				}
			}
		}
	}
	request(
		method: OmpAuthorityBridgeMethod,
		params: Record<string, unknown>,
	): { id: string; response: Promise<ResponseFrame> } {
		const id = `request-${++this.#counter}`;
		const gate = Promise.withResolvers<ResponseFrame>();
		this.#pending.set(id, gate);
		this.child.stdin.write(
			`${JSON.stringify({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "request", id, method, params })}\n`,
		);
		return { id, response: gate.promise };
	}
	async success(method: OmpAuthorityBridgeMethod, params: Record<string, unknown>): Promise<unknown> {
		const frame = await this.request(method, params).response;
		if (!frame.ok) throw Object.assign(new Error(frame.error?.message ?? "bridge failed"), frame.error);
		return frame.result;
	}
	waitForEvent(predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		const existing = this.events.find(predicate);
		if (existing) return Promise.resolve(existing);
		const gate = Promise.withResolvers<Record<string, unknown>>();
		this.#eventWaiters.push({ predicate, resolve: gate.resolve });
		return gate.promise;
	}
	cancel(id: string): void {
		this.child.stdin.write(`${JSON.stringify({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "cancel", id })}\n`);
	}
	async close(): Promise<void> {
		await this.child.stdin.end();
		await this.child.exited;
	}
}

function context(sessionId: string, expectedRevision?: string): Record<string, unknown> {
	return {
		hostId: "smoke-host",
		sessionId,
		deviceId: "smoke-device",
		connectionId: "smoke-connection",
		capabilities: ["session.read", "session.write", "terminal.control"],
		...(expectedRevision === undefined ? {} : { expectedRevision }),
	};
}

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
});

describe("OMP authority bridge source CLI", () => {
	test("serves the full authority contract and fences every mutation family", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-home-"));
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-project-"));
		homes.push(home, project);
		await fs.writeFile(path.join(project, "note.txt"), "hello\n");
		const child = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", "bridge", "--stdio"], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env, HOME: home, OMP_DISABLE_MCP: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const client = new BridgeClient(child);
		const ready = await client.ready.promise;
		expect(ready.methods).toEqual(OMP_AUTHORITY_BRIDGE_METHODS);

		const created = (await client.success("session.create", { cwd: project, title: "Bridge smoke" })) as Record<
			string,
			unknown
		>;
		const sessionId = String(created.sessionId);
		const sessionPath = String(created.path);
		const session = { ...created, entriesLoaded: false, entries: [] };
		const missingSession = { ...session, sessionId: "missing-session", path: path.join(home, "missing.jsonl") };
		expect(await client.request("discovery.load", { session: missingSession }).response).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
		const inventory = (await client.success("session.list", {})) as Record<string, unknown>;
		expect((inventory.sessions as unknown[]).length).toBe(1);
		expect(await client.request("session.fork", { session, cwd: "relative-project" }).response).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(
			await client.request("session.fork", { session, cwd: path.join(home, "missing-project") }).response,
		).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
		const forked = (await client.success("session.fork", { session, cwd: project })) as Record<string, unknown>;
		await client.success("session.archive", { session, archivedAt: new Date(0).toISOString() });
		await client.success("session.restore", { session });

		const manager = await SessionManager.open(sessionPath);
		manager.appendCustomEntry("desktop-review", {
			reviewId: "review-smoke",
			revision: "review-r1",
			status: "open",
			findings: [],
		});
		await manager.flush();
		await manager.close();

		const loaded = (await client.success("discovery.load", { session })) as Record<string, unknown>;
		expect(loaded.entriesLoaded).toBe(true);
		expect(
			await client.request("operation.filesRead", { args: { path: "../escape" }, context: context(sessionId) })
				.response,
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		const page = (await client.success("discovery.page", {
			session,
			args: { limit: 16, maxBytes: 32 * 1024 },
		})) as Record<string, unknown>;
		expect(Array.isArray(page.entries)).toBe(true);
		expect(await client.success("project.rootForProject", { projectId: created.projectId })).toBe(project);
		expect(await client.success("project.rootForSession", { sessionId })).toBe(project);
		await client.success("lock.check", { session });
		expect(await client.success("lock.status", { session })).toBe("missing");

		const read = (await client.success("operation.filesRead", {
			args: { path: "note.txt" },
			context: context(sessionId),
		})) as Record<string, unknown>;
		expect(read.content).toBe("hello\n");
		const revision = String(read.revision);
		const listing = (await client.success("operation.filesList", {
			args: {},
			context: context(sessionId),
		})) as Record<string, unknown>;
		expect((listing.entries as Record<string, unknown>[]).some(entry => entry.path === "note.txt")).toBe(true);
		const staleRevision = "0".repeat(64);
		expect(
			await client.request("operation.filesWrite", {
				args: { path: "note.txt", content: "stale\n", expectedRevision: staleRevision },
				context: context(sessionId, staleRevision),
			}).response,
		).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
		const written = (await client.success("operation.filesWrite", {
			args: { path: "note.txt", content: "hello two\n", expectedRevision: revision },
			context: context(sessionId, revision),
		})) as Record<string, unknown>;
		const writtenRevision = String(written.revision);
		const diff = (await client.success("operation.filesDiff", {
			args: { path: "note.txt", content: "patched\n", fromRevision: writtenRevision },
			context: context(sessionId, writtenRevision),
		})) as Record<string, unknown>;
		expect(String(diff.diff)).toContain("+patched");
		const patch = "*** Begin Patch\n*** Update File: note.txt\n@@\n-hello two\n+patched\n*** End Patch\n";
		expect(
			await client.request("operation.filesPatch", {
				args: { path: "note.txt", patch: "not a patch", expectedRevision: writtenRevision },
				context: context(sessionId, writtenRevision),
			}).response,
		).toMatchObject({ ok: false, error: { code: "OPERATION_FAILED" } });
		await client.success("operation.filesPatch", {
			args: { path: "note.txt", patch, expectedRevision: writtenRevision },
			context: context(sessionId, writtenRevision),
		});

		const review = (await client.success("operation.reviewRead", {
			args: { reviewId: "review-smoke" },
			context: context(sessionId),
		})) as Record<string, unknown>;
		expect(review.revision).toBe("review-r1");
		const applied = (await client.success("operation.reviewApply", {
			args: { reviewId: "review-smoke", expectedRevision: "review-r1" },
			context: context(sessionId, "review-r1"),
		})) as Record<string, unknown>;
		expect(applied.status).toBe("applied");

		expect(
			await client.request("operation.reviewRead", {
				args: { reviewId: "missing-review" },
				context: context(sessionId),
			}).response,
		).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		const bash = (await client.success("operation.bashRun", {
			args: { command: "printf bridge-bash" },
			context: context(sessionId),
		})) as Record<string, unknown>;
		expect(bash.stdout).toBe("bridge-bash");
		const cancelled = client.request("operation.bashRun", {
			args: { command: "sleep 30" },
			context: context(sessionId),
		});
		client.cancel(cancelled.id);
		expect(await cancelled.response).toMatchObject({ ok: true, result: { cancelled: true } });

		const terminal = (await client.success("operation.termOpen", {
			args: { shell: "/bin/sh", cols: 80, rows: 24 },
			context: context(sessionId),
		})) as Record<string, unknown>;
		const terminalId = String(terminal.terminalId);
		await client.success("terminal.input", {
			frame: { terminalId, data: "printf 'bridge-term\\n'\n" },
			context: context(sessionId),
		});
		const outputEvent = await client.waitForEvent(event => JSON.stringify(event).includes("bridge-term"));
		expect(outputEvent).toMatchObject({ payload: { terminalId } });
		await client.success("terminal.resize", {
			frame: { terminalId, cols: 100, rows: 30 },
			context: context(sessionId),
		});
		const wrongTerminalContext = { ...context(sessionId), connectionId: "other-connection" };
		expect(
			await client.request("terminal.resize", {
				frame: { terminalId, cols: 90, rows: 25 },
				context: wrongTerminalContext,
			}).response,
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		await client.success("terminal.close", { frame: { terminalId }, context: context(sessionId) });

		const catalog = (await client.success("operation.catalogGet", {
			args: { kind: "setting" },
			context: context(sessionId),
		})) as Record<string, unknown>;
		expect((catalog.items as unknown[]).length).toBeGreaterThan(0);
		const settings = (await client.success("operation.settingsRead", {
			args: { path: "advisor.enabled" },
			context: context(sessionId),
		})) as Record<string, unknown>;
		const settingsRevision = String(settings.revision);
		await client.success("operation.settingsWrite", {
			args: { path: "advisor.enabled", value: true, expectedRevision: settingsRevision },
			context: context(sessionId, settingsRevision),
		});
		const settingsAfter = (await client.success("operation.settingsRead", {
			args: {},
			context: context(sessionId),
		})) as Record<string, unknown>;
		await client.success("operation.configWrite", {
			args: { path: "prewalk.enabled", value: true, expectedRevision: settingsAfter.revision },
			context: context(sessionId, String(settingsAfter.revision)),
		});
		expect(await client.success("operation.brokerStatus", { args: {}, context: context(sessionId) })).toMatchObject({
			state: expect.any(String),
		});
		expect(await client.success("usage.read", {})).toMatchObject({
			reports: expect.any(Array),
			generatedAt: expect.any(Number),
		});
		expect(
			await client.request("operation.settingsRead", {
				args: { path: "unknown.setting" },
				context: context(sessionId),
			}).response,
		).toMatchObject({ ok: false });
		await client.success("session.delete", { session: { ...forked, entriesLoaded: false, entries: [] } });
		await client.success("authority.flush", {});
		await client.success("authority.quiesce", {});

		const fenced: OmpAuthorityBridgeMethod[] = [
			"session.create",
			"session.fork",
			"session.archive",
			"session.restore",
			"session.delete",
			"operation.filesWrite",
			"operation.filesPatch",
			"operation.reviewApply",
			"operation.bashRun",
			"operation.termOpen",
			"operation.settingsWrite",
			"operation.configWrite",
			"terminal.input",
			"terminal.resize",
			"terminal.close",
		];
		for (const method of fenced)
			expect(await client.request(method, {}).response).toMatchObject({ ok: false, error: { code: "QUIESCED" } });
		expect(await client.success("session.list", {})).toMatchObject({ sessions: expect.any(Array) });

		await client.close();
		await fs.rm(String(forked.path), { force: true });
	});
});
