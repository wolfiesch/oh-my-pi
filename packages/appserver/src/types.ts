import type { ChildProcess } from "node:child_process";
import type {
	ClientFrame,
	CommandFrame,
	Cursor,
	DurableEntry,
	HelloFrame,
	HostId,
	PairStartFrame,
	ServerFrame,
	ProjectId,
	Revision,
	SessionEvent,
	SessionId,
	SessionRef,
} from "@oh-my-pi/app-wire";
import type { DesktopOperationsAuthority } from "./operations/dispatcher.ts";
import type { ListenerPeerContext, RemoteConnection, RemoteListenerConfig, RemotePeerIdentity } from "./remote/types.ts";
import type { BunRemoteListener } from "./remote/listener.ts";

export interface ConnectionTransport {
	readonly connectionId: string;
	readonly deviceId: string;
	readonly remote: boolean;
	send(text: string): boolean;
	close(code?: number, reason?: string): void;
}
export interface RemoteHelloDecision {
	authenticated: boolean;
	grantedCapabilities?: readonly string[];
	grantedFeatures?: readonly string[];
	authentication?: string;
	deviceId?: string;
}
export interface RemoteAuthorizationContext {
	readonly connectionId: string;
	readonly peer: ListenerPeerContext;
	readonly command?: CommandFrame;
}
export interface RemoteConnectionPolicy {
	authenticate(connection: RemoteConnection, hello: HelloFrame): RemoteHelloDecision | Promise<RemoteHelloDecision>;
	pairStart?(connection: RemoteConnection, frame: PairStartFrame): ServerFrame | undefined | Promise<ServerFrame | undefined>;
	handleCommand?(connection: RemoteConnection, frame: CommandFrame): ServerFrame | undefined | Promise<ServerFrame | undefined>;
	authorize(
		connection: RemoteConnection,
		frame: ClientFrame,
		context: RemoteAuthorizationContext,
	): boolean | Promise<boolean>;
	transformOutbound?(
		connection: RemoteConnection,
		frame: ServerFrame,
	): ServerFrame | string | undefined | Promise<ServerFrame | string | undefined>;
	disconnected?(connection: RemoteConnection): void | Promise<void>;
}

export interface Clock {
	now(): Date;
}
export interface FileSystem {
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	unlink(path: string): Promise<void>;
	stat(
		path: string,
	): Promise<{ isFile(): boolean; isDirectory(): boolean; mode: number; mtimeMs: number; size: number }>;
	readdir(path: string): Promise<string[]>;
	readFile(path: string): Promise<string | Uint8Array>;
}
export interface SessionRecord {
	sessionId: SessionId;
	path: string;
	cwd: string;
	projectId: ProjectId;
	projectName?: string;
	title: string;
	updatedAt: string;
	status: SessionRef["status"];
	entries: DurableEntry[];
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
export interface SessionDiscovery {
	list(): Promise<SessionRecord[]>;
}
export interface ChildHandle {
	stdin: { write(data: string): Promise<void> | void };
	stderr?: AsyncIterable<string | Uint8Array>;
	stdout: AsyncIterable<string | Uint8Array>;
	exited: Promise<number>;
	kill(signal?: string): void;
}
export type LockCheckHook = (session: SessionRecord) => Promise<void> | void;
export interface RpcChildFactory {
	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle;
	argv(sessionPath: string): string[];
}
export interface AppserverOptions {
	hostId?: HostId;
	epoch?: string;
	clock?: Clock;
	discovery?: SessionDiscovery;
	sessionAuthority?: SessionAuthority;
	operationsAuthority?: DesktopOperationsAuthority;
	projectRootForProject?: (projectId: ProjectId) => Promise<string> | string;
	childFactory?: RpcChildFactory;
	lockCheck?: LockCheckHook;
	socketPath?: string;
	ompVersion?: string;
	ompBuild?: string;
	appserverVersion?: string;
	appserverBuild?: string;
	supportedFeatures?: readonly string[];
	supportedCapabilities?: readonly string[];
	ringSize?: number;
	now?: () => Date;
	remoteEndpoint?: RemoteListenerConfig;
	remotePolicy?: RemoteConnectionPolicy;
	remoteResolver?: { resolve(address: string): Promise<RemotePeerIdentity> };
	remoteListener?: BunRemoteListener;
}
export interface Projection {
	hostId: HostId;
	sessionId: SessionId;
	revision: Revision;
	cursor: Cursor;
	entries: DurableEntry[];
	ref: SessionRef;
	ring: ServerFrame[];
}
export interface CommandOutcome {
	frame: ServerFrame;
	unknown?: boolean;
}
export interface AppserverHandle {
	readonly hostId: HostId;
	readonly epoch: string;
	readonly socketPath: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	snapshot(sessionId: SessionId): Projection | undefined;
	replay(sessionId: SessionId, cursor: Cursor): ServerFrame[];
	childFor(sessionId: SessionId): ChildHandle | undefined;
}
export type {
	ChildProcess,
	CommandFrame,
	Cursor,
	DurableEntry,
	HostId,
	ProjectId,
	Revision,
	ServerFrame,
	SessionEvent,
	SessionId,
	SessionRef,
};
