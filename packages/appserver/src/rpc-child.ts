import type { ChildHandle, RpcChildFactory, SessionRecord } from "./types.ts";
import type { RpcSessionEntryFrame, RpcResponse } from "../../coding-agent/src/modes/rpc/rpc-types.ts";

const MAX_LINE_BYTES = 1024 * 1024;
export interface ChildCallbacks { entry(frame: RpcSessionEntryFrame): void; event(frame: Record<string, unknown>): void; crashed(error: Error): void; }
export class BunRpcChildFactory implements RpcChildFactory {
  constructor(private readonly executable = "omp") {}
  spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle {
    const child = Bun.spawn(spec.argv, { cwd: spec.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return { stdin: child.stdin, stdout: child.stdout as unknown as AsyncIterable<Uint8Array>, exited: child.exited, kill: signal => child.kill(signal as never) };
  }
  argv(): string[] { return [this.executable, "--mode", "rpc"]; }
}
async function* lines(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder(); let pending = "";
  for await (const chunk of stream) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let index; while ((index = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, index).replace(/\r$/, ""); pending = pending.slice(index + 1); if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB"); yield line; }
  }
  if (pending) { if (new TextEncoder().encode(pending).byteLength > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB"); yield pending; }
}
export class RpcChildSupervisor {
  #child?: ChildHandle; #pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>(); #closed = false; #readyReject?: (error: Error) => void;
  constructor(private readonly factory: RpcChildFactory, private readonly session: SessionRecord, private readonly callbacks: ChildCallbacks, private readonly argv = ["omp", "--mode", "rpc"]) {}
  async start(): Promise<void> {
    if (this.#child) throw new Error("child already started"); this.#child = this.factory.spawn({ session: this.session, argv: this.argv, cwd: this.session.cwd });
    const ready = Promise.withResolvers<void>(); this.#readyReject = ready.reject;
    void (async () => { try { for await (const line of lines(this.#child!.stdout)) { if (!line) continue; let value: Record<string, unknown>; try { value = JSON.parse(line); } catch { throw new Error("malformed rpc stdout"); } if (value.type === "ready") { ready.resolve(); continue; } this.dispatch(value); } if (!this.#closed) this.fail(new Error("rpc child stdout EOF")); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); } })();
    void this.#child.exited.then(code => { if (!this.#closed && code !== 0) this.fail(new Error(`rpc child exited (${code})`)); });
    const timer = setTimeout(() => ready.reject(new Error("rpc child ready timeout")), 10_000); try { await ready.promise; } finally { clearTimeout(timer); }
  }
  async call(command: Record<string, unknown>, id: string): Promise<RpcResponse> {
    if (!this.#child || this.#closed) throw new Error("rpc child unavailable"); const promise = Promise.withResolvers<RpcResponse>(); this.#pending.set(id, promise); try { const line = `${JSON.stringify({ ...command, id })}\n`; if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB"); await this.#child.stdin.write(line); return await promise.promise; } catch (error) { this.#pending.delete(id); throw error; }
  }
  async prompt(id: string, message: string): Promise<RpcResponse> { return this.call({ type: "prompt", message }, id); }
  async cancel(id: string): Promise<RpcResponse> { return this.call({ type: "abort" }, id); }
  stop(): void { this.#closed = true; this.#child?.kill(); this.fail(new Error("rpc child stopped")); this.#child = undefined; }
  child(): ChildHandle | undefined { return this.#child; }
  private dispatch(value: Record<string, unknown>): void { if (value.type === "response" && typeof value.id === "string") { const p = this.#pending.get(value.id); if (p) { this.#pending.delete(value.id); p.resolve(value as unknown as RpcResponse); } return; } if (value.type === "session_entry") { this.callbacks.entry(value as unknown as RpcSessionEntryFrame); return; } this.callbacks.event(value); }
  private fail(error: Error): void { this.#readyReject?.(error); this.#readyReject = undefined; for (const p of this.#pending.values()) p.reject(error); this.#pending.clear(); if (!this.#closed) { this.#closed = true; this.callbacks.crashed(error); } }
}
