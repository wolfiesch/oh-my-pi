import { parseBounded } from "@oh-my-pi/app-wire";
import type { RpcSessionEntryFrame, RpcResponse } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import type { ChildHandle, RpcChildFactory, SessionRecord } from "./types.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const STDERR_BYTES = 64 * 1024;

export interface ChildCallbacks { entry(frame: RpcSessionEntryFrame): void; event(frame: Record<string, unknown>): void; crashed(error: Error): void; }

export interface RpcChildInvocation {
  executable: string;
  prefixArgv: readonly string[];
}

export interface RpcChildInvocationOverrides {
  compiled?: boolean;
  executable?: string;
  main?: string;
}

export function resolveRpcChildInvocation(overrides: RpcChildInvocationOverrides = {}): RpcChildInvocation {
  const executable = overrides.executable ?? process.execPath;
  if (typeof executable !== "string" || executable.trim().length === 0) throw new Error("rpc child executable is empty");
  const compiled = overrides.compiled ?? process.env.PI_COMPILED === "true";
  const runningAppserverEntrypoint = typeof Bun.main === "string" && Bun.main.endsWith("/packages/appserver/bin/ompd.ts");
  const main = overrides.main ?? (runningAppserverEntrypoint ? new URL("../../coding-agent/src/cli.ts", import.meta.url).pathname : Bun.main);
  if (!compiled && (typeof main !== "string" || main.trim().length === 0)) throw new Error("rpc child CLI entry is empty");
  return { executable, prefixArgv: Object.freeze(compiled ? [] : [main]) };
}

export class BunRpcChildFactory implements RpcChildFactory {
  #executable: string;
  #prefixArgv: readonly string[];

  constructor(invocation: string | RpcChildInvocation = resolveRpcChildInvocation()) {
    const resolved = typeof invocation === "string" ? { executable: invocation, prefixArgv: [] } : invocation;
    if (typeof resolved.executable !== "string" || resolved.executable.trim().length === 0) {
      throw new Error("rpc child executable is empty");
    }
    if (!Array.isArray(resolved.prefixArgv) || resolved.prefixArgv.some(arg => typeof arg !== "string" || arg.length === 0)) {
      throw new Error("rpc child prefix argv is invalid");
    }
    this.#executable = resolved.executable;
    this.#prefixArgv = Object.freeze([...resolved.prefixArgv]);
  }

  spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle {
    const child = Bun.spawn(spec.argv, { cwd: spec.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return { stdin: { write: data => Promise.resolve(child.stdin.write(data)).then(() => undefined) }, stdout: child.stdout as unknown as AsyncIterable<Uint8Array>, stderr: child.stderr as unknown as AsyncIterable<Uint8Array>, exited: child.exited, kill: signal => child.kill(signal as never) };
  }

  argv(sessionPath: string): string[] {
    return [this.#executable, ...this.#prefixArgv, "--mode", "rpc", "--session", sessionPath];
  }
}

function stringBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error("invalid UTF-8 stdout");
      bytes += 4; i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid UTF-8 stdout");
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

async function* lines(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of stream) {
    let text: string;
    try { text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }); } catch { throw new Error("invalid UTF-8 stdout"); }
    pending += text;
    if (stringBytes(pending) > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB");
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      yield line;
    }
  }
  try { pending += decoder.decode(); } catch { throw new Error("invalid UTF-8 stdout"); }
  if (pending) {
    if (stringBytes(pending) > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB");
    yield pending;
  }
}

export class RpcChildSupervisor {
	#child?: ChildHandle;
	#pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
	#ignoredResponses = new Set<string>();
	#closed = false;
	#readyReject?: (error: Error) => void;
	#counter = 0;
	#stderr = "";
	#ready = false;
  constructor(private readonly factory: RpcChildFactory, private readonly session: SessionRecord, private readonly callbacks: ChildCallbacks, private readonly argv = ["omp", "--mode", "rpc"]) {}
  async start(): Promise<void> {
    if (this.#child) throw new Error("child already started");
    this.#child = this.factory.spawn({ session: this.session, argv: this.argv, cwd: this.session.cwd });
    const ready = Promise.withResolvers<void>(); this.#readyReject = ready.reject;
    void this.readStdout(ready); void this.readStderr();
    void this.#child.exited.then(code => { if (!this.#closed && code !== 0) this.fail(new Error(`rpc child exited (${code}): ${this.#stderr}`)); });
    const timer = setTimeout(() => ready.reject(new Error("rpc child ready timeout")), 10_000);
    try { await ready.promise; } catch (error) { this.stop(); throw error; } finally { clearTimeout(timer); this.#readyReject = undefined; }
  }
	async call(command: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<RpcResponse> {
		if (!this.#child || this.#closed || !this.#ready) throw new Error("rpc child unavailable");
		const internalId = `${requestId}:${++this.#counter}`;
		const promise = Promise.withResolvers<RpcResponse>();
		this.#pending.set(internalId, promise);
		const onAbort = () => {
			const pending = this.#pending.get(internalId);
			if (!pending) return;
			this.#pending.delete(internalId);
			this.#ignoredResponses.add(internalId);
			pending.reject(new Error("rpc call aborted"));
			void this.cancel(`${requestId}:cancel`).catch(() => undefined);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const line = `${JSON.stringify({ ...command, id: internalId })}\n`;
			if (stringBytes(line) > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB");
			await this.#child.stdin.write(line);
			const response = await promise.promise;
			if (response.type !== "response" || response.command !== command.type || typeof response.success !== "boolean")
				throw new Error("rpc response command mismatch");
			return response;
		} catch (error) {
			this.#pending.delete(internalId);
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
	async prompt(id: string, message: string, signal?: AbortSignal): Promise<RpcResponse> {
		return this.call({ type: "prompt", message }, id, signal);
	}
	async cancel(id: string): Promise<RpcResponse> {
		return this.call({ type: "abort" }, id);
	}
	async respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void> {
		if (!this.#child || this.#closed || !this.#ready) throw new Error("rpc child unavailable");
		const line = `${JSON.stringify({ type: "extension_ui_response", id: requestId, ...payload })}\n`;
		if (stringBytes(line) > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB");
		await this.#child.stdin.write(line);
	}
  stop(): void { const child = this.#child; this.#closed = true; child?.kill(); this.fail(new Error("rpc child stopped")); this.#child = undefined; }
  child(): ChildHandle | undefined { return this.#child; }
  private async readStdout(ready: { resolve: () => void; reject: (error: Error) => void }): Promise<void> {
    try {
      for await (const line of lines(this.#child!.stdout)) {
        if (!line) continue;
        let value: unknown;
        try { value = parseBounded(line); } catch { throw new Error("malformed rpc stdout"); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rpc frame must be an object");
        const frame = value as Record<string, unknown>;
        if (frame.type === "ready") { if (this.#ready) throw new Error("duplicate rpc ready"); this.#ready = true; ready.resolve(); continue; }
        this.dispatch(frame);
      }
      if (!this.#closed) this.fail(new Error("rpc child stdout EOF"));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error)); ready.reject(failure); this.fail(failure);
    }
  }
  private async readStderr(): Promise<void> {
    if (!this.#child?.stderr) return;
    try {
      for await (const chunk of this.#child.stderr) {
        const text = typeof chunk === "string" ? chunk.slice(-STDERR_BYTES) : new TextDecoder("utf-8", { fatal: false }).decode(chunk.byteLength > STDERR_BYTES ? chunk.slice(-STDERR_BYTES) : chunk);
        this.#stderr = `${this.#stderr}${text}`.slice(-STDERR_BYTES);
      }
    } catch {}
  }
  private dispatch(value: Record<string, unknown>): void {
    if (value.type === "response") {
      if (typeof value.id !== "string" || typeof value.command !== "string" || typeof value.success !== "boolean") throw new Error("malformed rpc response");
      const pending = this.#pending.get(value.id);
      if (!pending) {
        if (this.#ignoredResponses.delete(value.id)) return;
        throw new Error("rpc response has unknown id");
      }
      this.#pending.delete(value.id);
      if (!value.success && typeof value.error !== "string") pending.reject(new Error("rpc response missing error"));
      else pending.resolve(value as unknown as RpcResponse);
      return;
    }
    if (value.type === "session_entry") {
      if (!value.entry || typeof value.entry !== "object" || Array.isArray(value.entry)) throw new Error("malformed rpc session entry");
      this.callbacks.entry(value as unknown as RpcSessionEntryFrame); return;
    }
    if (typeof value.type !== "string") throw new Error("rpc frame type is missing");
    this.callbacks.event(value);
  }
  private fail(error: Error): void {
    this.#readyReject?.(error); this.#readyReject = undefined;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!this.#closed) { this.#closed = true; this.callbacks.crashed(error); }
  }
}
