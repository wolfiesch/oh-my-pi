import { postmortem } from "@oh-my-pi/pi-utils";

export interface RpcSessionTeardownDeps {
	/** Fence new work synchronously before cleanup begins. */
	beginDispose(): void;
	/** Detach RPC-only listeners and reject protocol requests that cannot complete. */
	cleanupProtocol(): void;
	/** Flush and release the session's persisted resources, including its writer lock. */
	disposeSession(reason?: postmortem.Reason): Promise<void>;
}

export interface RpcSessionTeardownHandle {
	/**
	 * Graceful in-process shutdown used by stdin EOF and extension-requested exit.
	 * Unregisters the postmortem callback before running the shared teardown.
	 */
	shutdown(reason?: postmortem.Reason): Promise<void>;
}

type RegisterCleanup = (id: string, callback: (reason: postmortem.Reason) => void | Promise<void>) => () => void;

/**
 * Register the RPC session's process-cleanup path and return the matching
 * in-process shutdown handle. The first caller owns the teardown reason and
 * every later caller awaits the same promise.
 */
export function registerRpcSessionTeardown(
	deps: RpcSessionTeardownDeps,
	register: RegisterCleanup = postmortem.register,
): RpcSessionTeardownHandle {
	let pending: Promise<void> | undefined;
	const teardown = (reason?: postmortem.Reason): Promise<void> => {
		if (pending) return pending;
		deps.beginDispose();
		pending = Promise.try(async () => {
			try {
				deps.cleanupProtocol();
			} finally {
				await deps.disposeSession(reason);
			}
		});
		return pending;
	};
	const unregister = register("rpc-session-teardown", teardown);
	let registered = true;
	return {
		shutdown(reason) {
			if (registered) {
				registered = false;
				unregister();
			}
			return teardown(reason);
		},
	};
}
