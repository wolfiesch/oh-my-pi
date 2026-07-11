import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hostId } from "@oh-my-pi/app-wire";
import type { HostId } from "@oh-my-pi/app-wire";

export function createHostId(value?: string): HostId { return hostId(value ?? `host-${randomUUID()}`); }
export function createEpoch(value?: string): string { return value ?? `epoch-${randomUUID()}`; }
export function defaultSocketPath(platform = process.platform, home = homedir(), runtime = process.env.XDG_RUNTIME_DIR): string { return platform === "darwin" ? join(home, ".omp", "run", "appserver.sock") : join(runtime || join(home, ".omp", "run"), "omp", "appserver.sock"); }
export async function loadPersistentHostId(path = join(process.env.HOME || homedir(), ".omp", "agent", "appserver", "host-id")): Promise<HostId> {
  try { const value = (await readFile(path, "utf8")).trim(); if (value) return hostId(value); } catch {}
  const value = createHostId(); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700); const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, `${value}\n`, { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600); return value;
}
export async function unixSocketActive(path: string): Promise<boolean> { const gate = Promise.withResolvers<boolean>(); const socket = createConnection(path); socket.once("connect", () => { socket.destroy(); gate.resolve(true); }); socket.once("error", error => { socket.destroy(); gate.resolve((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" && (error as NodeJS.ErrnoException).code !== "ENOENT"); }); return gate.promise; }
