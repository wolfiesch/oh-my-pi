import { describe, expect, test } from "bun:test";
import { DEVICE_CAPABILITIES, commandId, decodeCommand, hostId, requestId, sessionId, terminalId } from "@oh-my-pi/app-wire";
import { DesktopOperationDispatcher, TerminalOwnerRegistry, type DesktopOperationsAuthority, type OperationContext } from "../src/operations/dispatcher.ts";

const authority = new Proxy({}, { get: (_target, property) => async () => property === "filesRead" ? { content: "hello" } : property === "filesList" ? { entries: [] } : property === "filesDiff" ? { diff: "" } : property === "catalogGet" ? { items: [] } : property === "termOpen" ? { terminalId: "term-1" } : property === "agentCancel" ? { cancelled: true } : property === "previewCapture" ? { content: "" } : {} }) as unknown as DesktopOperationsAuthority;
const context: OperationContext = { hostId: hostId("host-1"), sessionId: sessionId("session-1"), deviceId: "device-1", connectionId: "connection-1", capabilities: new Set(DEVICE_CAPABILITIES), currentRevision: "r-1" as never, abortSignal: new AbortController().signal };
function command(name: string, args: Record<string, unknown> = {}, session = true, expectedRevision?: string) { const requiredRevision = ["files.write", "files.patch", "review.apply", "settings.write", "config.write"].includes(name); return decodeCommand({ v: "omp-app/1", type: "command", requestId: requestId(`request-${name}`), commandId: commandId(`command-${name}`), hostId: context.hostId, ...(session ? { sessionId: context.sessionId } : {}), command: name, ...((expectedRevision || requiredRevision) ? { expectedRevision: expectedRevision ?? "r-1" } : {}), args }); }

describe("desktop operation dispatcher", () => {
  test("routes operation families through typed authority", async () => {
    const dispatcher = new DesktopOperationDispatcher(authority);
    for (const name of ["files.read", "files.list", "files.diff", "files.write", "files.patch", "review.read", "review.apply", "agent.cancel", "bash.run", "catalog.get", "settings.read", "settings.write", "config.write", "preview.launch", "preview.state", "preview.navigate", "preview.capture"]) {
      const args = name.startsWith("files.") ? { path: "src/a.txt", ...(name === "files.write" ? { content: "x" } : {}), ...(name === "files.patch" ? { patch: "x" } : {}) } : name.startsWith("review.") ? { reviewId: "review-1" } : name === "agent.cancel" ? { agentId: "agent-1" } : name.startsWith("preview.") && ["preview.launch", "preview.navigate"].includes(name) ? { url: "http://localhost" } : name === "bash.run" ? { command: "structured" } : {};
      const hostCommand = ["catalog.get", "settings.read", "settings.write", "config.write"].includes(name);
      await expect(dispatcher.dispatch(command(name, args, !hostCommand), { ...context, ...(hostCommand ? { sessionId: undefined } : {}) })).resolves.toBeObject();
    }
  });
  test("rejects wrong host/scope, stale revision, abort, missing capability, and redacts authority errors", async () => {
    const dispatcher = new DesktopOperationDispatcher(new Proxy({}, { get: () => async () => { throw { code: "secret-provider", message: "token=bad" }; } }) as unknown as DesktopOperationsAuthority);
    await expect(dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, sessionId: sessionId("other") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(dispatcher.dispatch(command("files.read", { path: "a" }, true, "r-2"), context)).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
    await expect(dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, capabilities: new Set() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(dispatcher.dispatch(command("files.read", { path: "a" }), context)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });
  test("terminal owner registry rejects wrong connection and releases on disconnect", () => {
    const registry = new TerminalOwnerRegistry(); const owner = { connectionId: context.connectionId, deviceId: context.deviceId, hostId: context.hostId, sessionId: context.sessionId!, terminalId: terminalId("term-1") }; registry.claim(owner); expect(() => registry.assert({ ...owner, connectionId: "other" })).toThrow(); registry.releaseConnection(context.connectionId); expect(() => registry.assert(owner)).toThrow();
  });
  test("validates terminal output ownership and cleans all owners after disconnect failures", async () => {
    let opened = 0; let closes = 0; let outputs = 0; const terminalAuthority = new Proxy({}, { get: (_target, property) => async () => { if (property === "termOpen") return { terminalId: `term-${++opened}` }; if (property === "terminalClose") { closes++; if (closes === 1) throw new Error("close failed"); return; } if (property === "terminalOutput") { outputs++; return; } return {}; } }) as unknown as DesktopOperationsAuthority;
    const dispatcher = new DesktopOperationDispatcher(terminalAuthority); const first = await dispatcher.dispatch(command("term.open"), context); await dispatcher.dispatch({ ...command("term.open"), commandId: commandId("command-term-open-2"), requestId: requestId("request-term-open-2") }, context); const owner = { connectionId: context.connectionId, deviceId: context.deviceId, hostId: context.hostId, sessionId: context.sessionId!, terminalId: terminalId(String(first.terminalId)) };
    expect(() => dispatcher.publishTerminalOutput({ v: "omp-app/1", type: "terminal.output", hostId: context.hostId, sessionId: context.sessionId, terminalId: owner.terminalId, cursor: { epoch: "e", seq: 1 }, stream: "stdout", data: "x" }, owner)).not.toThrow(); expect(outputs).toBe(1); expect(() => dispatcher.publishTerminalOutput({ v: "omp-app/1", type: "terminal.output", hostId: context.hostId, sessionId: context.sessionId, terminalId: terminalId("spoof"), cursor: { epoch: "e", seq: 1 }, stream: "stdout", data: "x" }, owner)).toThrow(); await expect(dispatcher.disconnect(context.connectionId, { ...context, sessionId: context.sessionId! })).rejects.toMatchObject({ code: "OPERATION_FAILED" }); expect(closes).toBe(2); expect(() => dispatcher.publishTerminalOutput({ v: "omp-app/1", type: "terminal.output", hostId: context.hostId, sessionId: context.sessionId, terminalId: owner.terminalId, cursor: { epoch: "e", seq: 2 }, stream: "stdout", data: "x" }, owner)).toThrow();
  });
  test("abort signal is passed unchanged to authority", async () => {
    let seen: AbortSignal | undefined; const abortAuthority = new Proxy({}, { get: () => async (_args: unknown, ctx: OperationContext) => { seen = ctx.abortSignal; return { content: "ok" }; } }) as unknown as DesktopOperationsAuthority; const signal = new AbortController().signal; await new DesktopOperationDispatcher(abortAuthority).dispatch(command("files.read", { path: "a" }), { ...context, abortSignal: signal }); expect(seen).toBe(signal);
  });
});
