import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostId } from "@oh-my-pi/app-wire";
import type { HostId } from "@oh-my-pi/app-wire";

export function createHostId(value?: string): HostId {
  return hostId(value ?? `host-${randomUUID()}`);
}
export function createEpoch(value?: string): string { return value ?? `epoch-${randomUUID()}`; }
export function defaultSocketPath(platform = process.platform, home = homedir(), runtime = process.env.XDG_RUNTIME_DIR): string {
  return platform === "darwin" ? join(home, ".omp", "run", "appserver.sock") : join(runtime || join(home, ".omp", "run"), "omp", "appserver.sock");
}
