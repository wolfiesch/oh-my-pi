import type { ChildProcess } from "node:child_process";
import type { CommandFrame, DurableEntry, HostId, ProjectId, Revision, SessionEvent, SessionId, SessionRef, Cursor, ServerFrame } from "@oh-my-pi/app-wire";

export interface Clock { now(): Date; }
export interface FileSystem {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mode: number; mtimeMs: number; size: number }>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string | Uint8Array>;
}
export interface SessionRecord {
  sessionId: SessionId; path: string; cwd: string; projectId: ProjectId; projectName?: string;
  title: string; updatedAt: string; status: SessionRef["status"]; entries: DurableEntry[];
}
export interface SessionAuthoritySession {
  sessionId: SessionId;
  path: string;
  cwd: string;
  title?: string;
  entries: DurableEntry[];
}
export interface SessionAuthority {
  create(cwd: string, title?: string): Promise<SessionAuthoritySession>;
  list(): Promise<SessionRecord[]>;
}
export interface SessionDiscovery { list(): Promise<SessionRecord[]>; }
export interface ChildHandle {
  stdin: { write(data: string): Promise<void> | void };
  stderr?: AsyncIterable<string | Uint8Array>;
  stdout: AsyncIterable<string | Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}
export type LockCheckHook = (session: SessionRecord) => Promise<void> | void;
export interface RpcChildFactory { spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle; argv(sessionPath: string): string[]; }
export interface AppserverOptions {
  hostId?: HostId; epoch?: string; clock?: Clock; discovery?: SessionDiscovery; sessionAuthority?: SessionAuthority;
  childFactory?: RpcChildFactory; lockCheck?: LockCheckHook; socketPath?: string;
  ompVersion?: string; ompBuild?: string; appserverVersion?: string; appserverBuild?: string;
  supportedFeatures?: readonly string[];
  supportedCapabilities?: readonly string[];
  ringSize?: number; now?: () => Date;
}
export interface Projection {
  hostId: HostId; sessionId: SessionId; revision: Revision; cursor: Cursor; entries: DurableEntry[];
  ref: SessionRef; ring: ServerFrame[];
}
export interface CommandOutcome { frame: ServerFrame; unknown?: boolean; }
export interface AppserverHandle {
  readonly hostId: HostId; readonly epoch: string; readonly socketPath: string;
  start(): Promise<void>; stop(): Promise<void>; snapshot(sessionId: SessionId): Projection | undefined;
  replay(sessionId: SessionId, cursor: Cursor): ServerFrame[];
  childFor(sessionId: SessionId): ChildHandle | undefined;
}
export type { ChildProcess, CommandFrame, DurableEntry, HostId, ProjectId, Revision, SessionEvent, SessionId, SessionRef, Cursor, ServerFrame };
