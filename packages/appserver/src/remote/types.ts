export interface RemotePeerIdentity {
  nodeId: string;
  hostname?: string;
  user?: string;
  addresses: string[];
  source: "tailscale" | "serve" | "direct";
}
export interface ListenerPeerContext { identity: RemotePeerIdentity; address: string; source: "direct" | "serve"; }
export interface RemoteConnectionHooks {
  connected?(peer: ListenerPeerContext): void | Promise<void>;
  message?(peer: ListenerPeerContext, message: string | Uint8Array): void | Promise<void>;
  disconnected?(peer: ListenerPeerContext): void | Promise<void>;
}
export interface ProcessRunOptions { timeoutMs: number; maxOutputBytes: number; }
export interface ProcessRunner { run(argv: string[], options: ProcessRunOptions): Promise<{ stdout: string | Uint8Array; exitCode: number }>; }
export interface RemoteListenerConfig {
  address: string;
  port: number;
  trustedServeProxy?: boolean;
  serveProxy?: boolean;
  originAllowlist?: readonly string[];
  maxConnections?: number;
  maxFrameBytes?: number;
  idleTimeoutSeconds?: number;
  backpressureLimit?: number;
  whoisTimeoutMs?: number;
  whoisMaxOutputBytes?: number;
}
export interface ListenerPlan { mode: "direct" | "serve"; address: string; port: number; path: "/v1/ws"; trustedServeProxy: boolean; }
