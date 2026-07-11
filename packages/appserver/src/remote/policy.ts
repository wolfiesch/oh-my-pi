import { randomUUID } from "node:crypto";
import {
  COMMAND_DESCRIPTORS,
  DEVICE_CAPABILITIES,
  isSecretLikeKey,
  pairingId,
  type ClientFrame,
  type CommandFrame,
  type ConfirmFrame,
  type HelloFrame,
  type PairOkFrame,
  type PairStartFrame,
  type ServerFrame,
} from "@oh-my-pi/app-wire";
import {
  LocalPairingTicketIssuer,
  LeaseRegistry,
  SecureConfirmationStore,
  SqliteDeviceRegistry,
  TokenBucketLimiter,
  type AuthenticatedPrincipal,
  type AuthorizationGuard,
  type Capability,
  type Clock,
  type DeviceMetadata,
  type DeviceRegistry,
  type Lease,
  type PairingService,
  type Random,
  type RemotePeerIdentity as SecurityPeerIdentity,
} from "../security/index.ts";
import type { RemoteAuthorizationContext, RemoteConnectionPolicy, RemoteHelloDecision } from "../types.ts";
import type { ListenerPeerContext, RemoteConnection, RemotePeerIdentity } from "./types.ts";

interface ConnectionState {
  readonly connection: RemoteConnection;
  principal?: AuthenticatedPrincipal;
  capabilities: readonly Capability[];
  features: readonly string[];
  paired: boolean;
  justPaired: boolean;
  ready: boolean;
  readonly commandContexts: Map<string, { capability: Capability; sessionId?: string; leaseId?: string; lease?: Lease; released?: boolean }>;
}
export interface TailscaleRemotePolicyOptions {
  readonly registry: DeviceRegistry;
  readonly pairing?: PairingService;
  readonly localPairing?: LocalPairingTicketIssuer;
  readonly leases?: LeaseRegistry;
  readonly guard?: AuthorizationGuard;
  readonly limiter?: TokenBucketLimiter;
  readonly confirmations?: SecureConfirmationStore;
  readonly clock?: Clock;
  readonly random?: Random;
  readonly supportedCapabilities?: readonly string[];
  readonly supportedFeatures?: readonly string[];
}
export interface LocalPairingTicketFactoryOptions {
  readonly databasePath: string;
  readonly key: Uint8Array;
  readonly clock?: Clock;
  readonly random?: Random;
}
export function createTailscaleRemotePolicy(options: LocalPairingTicketFactoryOptions): TailscaleRemotePolicy {
  const registry = new SqliteDeviceRegistry(options.databasePath, options.clock, options.random);
  const localPairing = new LocalPairingTicketIssuer(registry, options.key, options.clock, options.random);
  return new TailscaleRemotePolicy({ registry, localPairing, clock: options.clock, random: options.random });
}
function securityIdentity(peer: RemotePeerIdentity): SecurityPeerIdentity {
  const address = peer.addresses[0];
  if (!address) throw new Error("peer identity invalid");
  return { nodeId: peer.nodeId, login: peer.user ?? peer.nodeId, hostId: peer.hostname ?? peer.nodeId, tailnetIp: address };
}
function safeString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function requestedCapabilities(hello: HelloFrame): Capability[] {
  return (hello.capabilities?.client ?? []).filter((value): value is Capability => (DEVICE_CAPABILITIES as readonly string[]).includes(value));
}
function capIntersection(granted: readonly string[], requested: readonly string[], supported: readonly string[]): Capability[] {
  const requestedSet = new Set(requested);
  const allowed = new Set(granted);
  return supported.filter((value): value is Capability => requestedSet.has(value) && allowed.has(value) && (DEVICE_CAPABILITIES as readonly string[]).includes(value));
}
function featureIntersection(granted: readonly string[], requested: readonly string[], supported: readonly string[]): string[] {
  const requestedSet = new Set(requested);
  const allowed = new Set(granted);
  return supported.filter(value => requestedSet.has(value) && allowed.has(value));
}
function leaseId(args: Record<string, unknown>): string | undefined { return typeof args.leaseId === "string" ? args.leaseId : undefined; }
function mutation(command: string): boolean {
  return command === "session.prompt" || command === "session.create" || command === "session.close" || command === "session.cancel" || command === "files.write" || command === "files.patch" || command === "review.apply" || command === "config.write" || command === "settings.write" || command === "term.input" || command === "term.resize" || command === "term.close" || command === "bash.run" || command === "agent.cancel" || command === "preview.launch" || command === "preview.navigate";
}
function frameCapability(frame: ClientFrame): Capability | undefined {
  if (frame.type === "command") return COMMAND_DESCRIPTORS[frame.command]?.capability;
  if (frame.type === "terminal.input" || frame.type === "terminal.resize" || frame.type === "terminal.close") return frame.type === "terminal.input" ? "term.input" : frame.type === "terminal.resize" ? "term.resize" : "term.open";
  return undefined;
}

export class TailscaleRemotePolicy implements RemoteConnectionPolicy {
  readonly #states = new Map<string, ConnectionState>();
  readonly #registry: DeviceRegistry;
  readonly #pairing?: PairingService;
  readonly #localPairing?: LocalPairingTicketIssuer;
  readonly #leases: LeaseRegistry;
  readonly #guard?: AuthorizationGuard;
  readonly #limiter?: TokenBucketLimiter;
  readonly #confirmations?: SecureConfirmationStore;
  readonly #clock: Clock;
  readonly #supportedCapabilities: readonly Capability[];
  readonly #supportedFeatures: readonly string[];
  constructor(options: TailscaleRemotePolicyOptions) {
    this.#registry = options.registry;
    this.#pairing = options.pairing;
    this.#localPairing = options.localPairing;
    this.#leases = options.leases ?? new LeaseRegistry(options.clock, options.random);
    this.#guard = options.guard;
    this.#limiter = options.limiter;
    this.#confirmations = options.confirmations;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#supportedCapabilities = (options.supportedCapabilities ?? DEVICE_CAPABILITIES).filter((value): value is Capability => (DEVICE_CAPABILITIES as readonly string[]).includes(value));
    this.#supportedFeatures = [...(options.supportedFeatures ?? ["resume", "controller.lease", "terminal.io", "files.list", "files.diff", "catalog.metadata", "settings.metadata"])];
  }
  issuePairingTicket(allowedCapabilities: readonly Capability[], ttlMs = 120_000, nodeId?: string): { readonly code: string; readonly expiresAt: number } {
    if (!this.#localPairing) throw new Error("local pairing issuer unavailable");
    return this.#localPairing.issue(allowedCapabilities, ttlMs, nodeId);
  }
  authenticate(connection: RemoteConnection, hello: HelloFrame): RemoteHelloDecision {
    const state: ConnectionState = { connection, capabilities: [], features: [], paired: false, justPaired: false, ready: false, commandContexts: new Map() };
    this.#states.set(connection.connectionId, state);
    if (hello.authentication === undefined) return { authenticated: false, authentication: "pairing-required", grantedCapabilities: [], grantedFeatures: [] };
    try {
      const principal = this.#registry.authenticate(hello.authentication.deviceId, hello.authentication.deviceToken, securityIdentity(connection.peer.identity), connection.connectionId);
      state.principal = principal;
      state.paired = true;
      state.ready = true;
      state.capabilities = capIntersection(principal.capabilities, requestedCapabilities(hello), this.#supportedCapabilities);
      state.features = featureIntersection(this.#supportedFeatures, hello.requestedFeatures, this.#supportedFeatures);
      return { authenticated: true, authentication: "paired", grantedCapabilities: state.capabilities, grantedFeatures: state.features, deviceId: principal.deviceId };
    } catch {
      return { authenticated: false, authentication: "denied", grantedCapabilities: [], grantedFeatures: [] };
    }
  }
  pairStart(connection: RemoteConnection, frame: PairStartFrame): PairOkFrame | undefined {
    const state = this.#states.get(connection.connectionId);
    if (!state || state.paired || !this.#localPairing) return undefined;
    const source = connection.peer.identity;
    if (this.#limiter && !this.#limiter.allowUnauthenticatedPairing(securityIdentity(source), connection.peer.address)) return undefined;
    try {
      const result = this.#localPairing.consume(frame.code, securityIdentity(source), frame.deviceId, { label: frame.deviceName, platform: frame.platform } satisfies DeviceMetadata, frame.requestedCapabilities as Capability[]);
      state.paired = true;
      state.justPaired = true;
      state.principal = this.#registry.authenticate(result.deviceId, result.token, securityIdentity(source), connection.connectionId);
      state.capabilities = result.capabilities;
      state.features = [];
      return {
        v: "omp-app/1",
        type: "pair.ok",
        requestId: frame.requestId,
        pairingId: pairingId(`pair-${randomUUID()}`),
        deviceId: result.deviceId,
        deviceName: frame.deviceName,
        platform: frame.platform,
        requestedCapabilities: [...frame.requestedCapabilities],
        grantedCapabilities: [...result.capabilities],
        deviceToken: result.token,
        expiresAt: new Date(result.tokenExpiresAt).toISOString(),
      };
    } catch {
      return undefined;
    }
  }
  authorize(connection: RemoteConnection, frame: ClientFrame, context: RemoteAuthorizationContext): boolean {
    const state = this.#states.get(connection.connectionId);
    if (!state) return false;
    if (!state.paired) return false;
    if (!state.ready) return false;
    if (state.justPaired) return false;
    const capability = frameCapability(frame);
    if (frame.type === "confirm") return this.authorizeConfirm(state, frame);
    if (!capability || !state.capabilities.includes(capability)) return false;
    if (frame.type === "command") {
      const descriptor = COMMAND_DESCRIPTORS[frame.command];
      if (!descriptor) return false;
      const lease = leaseId(frame.args);
      let leaseResult: Lease | undefined;
      let released = false;
      if (frame.command === "controller.lease.acquire") {
        if (!frame.sessionId) return false;
        try { leaseResult = this.#leases.acquire(state.principal!.deviceId, connection.connectionId, frame.sessionId, "controller", 30_000, state.principal!.epoch, frame.expectedRevision); } catch { return false; }
      } else if (frame.command === "controller.lease.renew" || frame.command === "controller.lease.release") {
        if (!lease) return false;
        if (frame.command.endsWith("renew")) { try { leaseResult = this.#leases.renew(lease, state.principal!.deviceId, connection.connectionId, 30_000, state.principal!.epoch, frame.expectedRevision, frame.command); } catch { return false; } }
        else { this.#leases.release(lease, state.principal!.deviceId, connection.connectionId, state.principal!.epoch, frame.expectedRevision, frame.command); released = true; }
      } else if (mutation(frame.command)) {
        if (!frame.sessionId || !lease || !this.#leases.verify(lease, state.principal!.deviceId, connection.connectionId, frame.sessionId, frame.command, state.principal!.epoch, frame.expectedRevision)) return false;
      }
      state.commandContexts.set(String(frame.commandId), { capability, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}), ...(lease ? { leaseId: lease } : {}), ...(leaseResult ? { lease: leaseResult } : {}), ...(released ? { released } : {}) });
      if (this.#guard && state.principal) {
        try { this.#guard.authorize({ principal: state.principal, command: frame.command, capabilities: state.capabilities, connectionId: connection.connectionId, sessionId: frame.sessionId, revision: frame.expectedRevision, leaseId: lease, confirmationId: frame.confirmationId, args: frame.args }); } catch { return false; }
      }
      return true;
    }
    return true;
  }
  handleCommand(connection: RemoteConnection, frame: CommandFrame): ServerFrame | undefined {
    if (!frame.command.startsWith("controller.lease.")) return undefined;
    const state = this.#states.get(connection.connectionId);
    const context = state?.commandContexts.get(String(frame.commandId));
    if (!state || !context) return undefined;
    const result = context.lease
      ? { leaseId: context.lease.leaseId, owner: context.lease.owner, deviceId: context.lease.deviceId, connectionId: context.lease.connectionId, sessionId: context.lease.sessionId, kind: context.lease.kind, expiresAt: context.lease.expiresAt }
      : { leaseId: context.leaseId, released: context.released === true };
    return { v: "omp-app/1", type: "response", requestId: frame.requestId, commandId: frame.commandId, command: frame.command, hostId: frame.hostId, sessionId: frame.sessionId, ok: true, result } as ServerFrame;
  }
  private authorizeConfirm(state: ConnectionState, frame: ConfirmFrame): boolean {
    const context = state.commandContexts.get(String(frame.commandId));
    if (!context || !state.principal || !state.capabilities.includes(context.capability)) return false;
    if (context.leaseId && context.sessionId && !this.#leases.verify(context.leaseId, state.principal.deviceId, state.connection.connectionId, context.sessionId, "session.prompt", state.principal.epoch)) return false;
    return true;
  }
  transformOutbound(connection: RemoteConnection, frame: ServerFrame): ServerFrame | undefined {
    const state = this.#states.get(connection.connectionId);
    if (!state) return undefined;
    if (frame.type === "pair.ok") {
      if (!state.justPaired) return undefined;
      state.justPaired = false;
      return frame;
    }
    const cloned = sanitizeRemoteFrame(frame);
    if (cloned === undefined) return undefined;
    return cloned as ServerFrame;
  }
  disconnected(connection: RemoteConnection): void {
    const state = this.#states.get(connection.connectionId);
    if (state?.principal) this.#leases.disconnect(state.principal.deviceId, connection.connectionId);
    else this.#leases.disconnect("", connection.connectionId);
    this.#states.delete(connection.connectionId);
  }
}

function sanitizeRemoteFrame(frame: ServerFrame): ServerFrame | undefined {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, key: string, depth: number): unknown => {
    if (depth > 12) throw new Error("outbound depth exceeded");
    if (typeof value === "string") {
      if (value.length > 65_536) throw new Error("outbound string exceeded");
      if (/^(?:[A-Za-z]+\s+)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value) || /^Bearer\s+/iu.test(value)) return "[redacted]";
      if ((key === "path" || key === "cwd" || key === "root" || key === "endpoint" || key === "projectRoot") && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value))) return "[relative-path-redacted]";
      return value;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("outbound cycle");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 128) throw new Error("outbound array exceeded");
      const result = value.map(item => walk(item, key, depth + 1));
      seen.delete(value);
      return result;
    }
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value);
    if (entries.length > 128) throw new Error("outbound object exceeded");
    for (const [childKey, child] of entries) {
      if (childKey === "deviceToken" || isSecretLikeKey(childKey)) {
        result[childKey] = "[redacted]";
      } else result[childKey] = walk(child, childKey, depth + 1);
    }
    seen.delete(value);
    return result;
  };
  try {
    const output = walk(frame, "", 0);
    return output && typeof output === "object" && !Array.isArray(output) ? output as ServerFrame : undefined;
  } catch {
    return undefined;
  }
}

export type { Lease, RemotePeerIdentity };
