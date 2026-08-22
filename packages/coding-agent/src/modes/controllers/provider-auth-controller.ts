import type { CredentialOriginKind, OAuthLoginIdentity } from "@oh-my-pi/pi-ai";
import { type OAuthProviderUnion, PROVIDER_REGISTRY, type ProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { RpcOperationHandle, RpcOperationManager } from "../rpc/rpc-operations";

export type ProviderAuthMethod = "oauth_callback" | "paste_code" | "device_code" | "api_key";

export interface ProviderAuthMethodCapability {
	method: ProviderAuthMethod;
	available: boolean;
	/** Authentication mutates process-wide credential state and is exclusive per RPC connection. */
	exclusive: true;
}

export interface ProviderAuthState {
	providerId: string;
	name: string;
	credentialOrigin?: CredentialOriginKind;
	authenticated: boolean;
	disabled: boolean;
	available: boolean;
	unavailableReason?: string;
	identity?: {
		email?: string;
		accountId?: string;
		projectId?: string;
		orgId?: string;
		orgName?: string;
	};
	methods: ProviderAuthMethodCapability[];
}

export interface ProviderAuthRequest {
	type: "provider_auth_request";
	operationId: string;
	requestId: string;
	providerId: string;
	method: "open_url";
	url: string;
	launchUrl?: string;
	instructions?: string;
}

export interface ProviderAuthUpdate {
	type: "provider_auth_update";
	state: ProviderAuthState;
}

export class ProviderAuthError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ProviderAuthError";
	}
}

function methodsFor(definition: ProviderDefinition): ProviderAuthMethodCapability[] {
	if (!definition.login || definition.headlessAuthUnavailableReason) return [];
	const methods: ProviderAuthMethod[] = [];
	if (definition.callbackPort !== undefined) methods.push("oauth_callback");
	if (definition.pasteCodeFlow) methods.push("paste_code");
	if (definition.deviceCodeFlow) methods.push("device_code");
	// Registry login definitions without an OAuth callback, paste-code, or
	// device-code capability are API-key entry flows. Provider-specific
	// exceptions must opt out with headlessAuthUnavailableReason.
	if (methods.length === 0) methods.push("api_key");
	return methods.map(method => ({ method, available: definition.available !== false, exclusive: true }));
}

function findDefinition(providerId: string): ProviderDefinition {
	const definition = PROVIDER_REGISTRY.find(candidate => candidate.id === providerId && candidate.login);
	if (!definition)
		throw new ProviderAuthError("provider_auth_unknown_provider", "Unknown provider authentication target");
	return definition;
}

/** Registry-driven, secret-free provider auth inventory and mutations. */
export class ProviderAuthService {
	constructor(
		private readonly modelRegistry: Pick<ModelRegistry, "authStorage" | "refreshProvider">,
		private readonly sessionId?: string,
	) {}

	list(): ProviderAuthState[] {
		return PROVIDER_REGISTRY.filter(definition => definition.login).map(definition => this.project(definition));
	}

	get(providerId: string): ProviderAuthState {
		return this.project(findDefinition(providerId));
	}

	assertMethod(providerId: string, method: ProviderAuthMethod): void {
		const state = this.get(providerId);
		const capability = state.methods.find(candidate => candidate.method === method);
		if (!capability)
			throw new ProviderAuthError(
				"provider_auth_method_unavailable",
				"The requested authentication method is unavailable for this provider",
			);
		if (!state.available || !capability.available)
			throw new ProviderAuthError("provider_auth_provider_unavailable", "Provider authentication is unavailable");
	}

	credentialTarget(providerId: string): { storageProvider: string; affectedProviderIds: string[] } {
		const definition = findDefinition(providerId);
		const storageProvider = definition.storeCredentialsAs ?? definition.id;
		const affectedProviderIds = PROVIDER_REGISTRY.filter(
			candidate =>
				candidate.login !== undefined && (candidate.storeCredentialsAs ?? candidate.id) === storageProvider,
		).map(candidate => candidate.id);
		return { storageProvider, affectedProviderIds };
	}

	async login(
		providerId: string,
		method: ProviderAuthMethod,
		callbacks: {
			signal: AbortSignal;
			onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			/**
			 * Synchronous commit boundary. Cancellation is accepted before this
			 * callback and rejected after it so persistence and terminal state
			 * cannot disagree.
			 */
			onBeforePersist?: () => void;
		},
	): Promise<{ state: ProviderAuthState; states: ProviderAuthState[]; identity?: OAuthLoginIdentity }> {
		this.assertMethod(providerId, method);
		const target = this.credentialTarget(providerId);
		const identity = await this.modelRegistry.authStorage.login(providerId as OAuthProviderUnion, {
			signal: callbacks.signal,
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			beforePersist: callbacks.onBeforePersist,
		});
		// AuthStorage returning means its authoritative persistence step committed.
		// A cancellation racing after that boundary must not turn durable credentials
		// into a cancelled terminal.
		await Promise.all(
			target.affectedProviderIds.map(affectedProviderId =>
				this.modelRegistry.refreshProvider(affectedProviderId, "online"),
			),
		);
		const states = target.affectedProviderIds.map(affectedProviderId => this.get(affectedProviderId));
		return { state: this.get(providerId), states, identity };
	}

	async remove(providerId: string): Promise<{ state: ProviderAuthState; states: ProviderAuthState[] }> {
		const definition = findDefinition(providerId);
		const target = this.credentialTarget(providerId);
		const state = this.project(definition);
		if (!state.authenticated)
			throw new ProviderAuthError("provider_auth_not_authenticated", "Provider is not authenticated");
		if (state.credentialOrigin !== "oauth" && state.credentialOrigin !== "api_key") {
			throw new ProviderAuthError(
				"provider_auth_origin_not_removable",
				"This credential origin cannot be removed through provider authentication",
			);
		}
		await this.modelRegistry.authStorage.remove(target.storageProvider);
		await Promise.all(
			target.affectedProviderIds.map(async affectedProviderId => {
				try {
					await this.modelRegistry.refreshProvider(affectedProviderId, "online");
				} catch (error) {
					logger.warn("Provider credentials were removed, but provider discovery refresh failed", {
						providerId: affectedProviderId,
						error: String(error),
					});
				}
			}),
		);
		const states = target.affectedProviderIds.map(affectedProviderId => this.get(affectedProviderId));
		return { state: this.get(providerId), states };
	}

	private project(definition: ProviderDefinition): ProviderAuthState {
		const storageProvider = definition.storeCredentialsAs ?? definition.id;
		const origin = this.modelRegistry.authStorage.getCredentialOrigin(storageProvider)?.kind;
		const methods = methodsFor(definition);
		const disabled = definition.showInLoginList === false;
		const available = definition.available !== false && !disabled && methods.some(method => method.available);
		return {
			providerId: definition.id,
			name: definition.name,
			credentialOrigin: origin,
			authenticated: this.modelRegistry.authStorage.hasAuth(storageProvider),
			disabled,
			available,
			unavailableReason:
				definition.headlessAuthUnavailableReason ??
				(definition.available === false
					? "Provider login is unavailable"
					: disabled
						? "Provider login is disabled"
						: undefined),
			identity: this.modelRegistry.authStorage.getOAuthAccountIdentity(storageProvider, this.sessionId),
			methods,
		};
	}
}

type ActiveAuthOperation = {
	handle: RpcOperationHandle;
	providerId: string;
	method: ProviderAuthMethod;
	abortController: AbortController;
	cancelReason?: "user" | "replaced" | "session_transition" | "client_disconnected";
	cancelCode?: "cancelled_by_client" | "replaced_by_prompt" | "session_changed" | "client_disconnected";
	commitStarted: boolean;
	task?: Promise<void>;
};
export type ProviderAuthCancellationResult = "cancelled" | "protected" | "not_found";

/** Owns one connection's correlated, cancelable provider-auth interaction. */
export class ProviderAuthController {
	#active: ActiveAuthOperation | undefined;
	#closed = false;
	#mutationReservation: symbol | undefined;

	constructor(
		private readonly service: ProviderAuthService,
		private readonly operations: RpcOperationManager,
		private readonly output: (frame: ProviderAuthRequest | ProviderAuthUpdate) => void,
		private readonly trackTask: (task: Promise<void>) => void,
		private readonly requestInput: (request: {
			operationId: string;
			providerId: string;
			method: "paste_code" | "api_key" | "secret_text";
			prompt: string;
			placeholder?: string;
			signal: AbortSignal;
		}) => Promise<string | undefined>,
	) {}

	begin(requestId: string | undefined, providerId: string, method: ProviderAuthMethod): RpcOperationHandle {
		if (this.#closed) throw new ProviderAuthError("provider_auth_disconnected", "Provider authentication is closed");
		if (this.#active || this.#mutationReservation)
			throw new ProviderAuthError(
				"provider_auth_busy",
				"Another provider authentication operation is already active",
			);
		this.service.assertMethod(providerId, method);
		const handle = this.operations.start(requestId, "provider_auth");
		const active: ActiveAuthOperation = {
			handle,
			providerId,
			method,
			abortController: new AbortController(),
			commitStarted: false,
		};
		this.#active = active;
		const task = new Promise<void>((resolve, reject) => {
			setImmediate(() => {
				this.run(active).then(resolve, reject);
			});
		});
		active.task = task;
		this.trackTask(task);
		return handle;
	}

	reserveMutation(): () => void {
		if (this.#closed) throw new ProviderAuthError("provider_auth_disconnected", "Provider authentication is closed");
		if (this.#active || this.#mutationReservation)
			throw new ProviderAuthError(
				"provider_auth_busy",
				"Another provider authentication operation is already active",
			);
		const reservation = Symbol("provider-auth-mutation");
		this.#mutationReservation = reservation;
		return () => {
			if (this.#mutationReservation === reservation) this.#mutationReservation = undefined;
		};
	}

	hasMutationInFlight(): boolean {
		return this.#mutationReservation !== undefined;
	}

	cancel(
		operationId: string,
		reason: "user" | "replaced" | "session_transition" | "client_disconnected" = "user",
		code: "cancelled_by_client" | "replaced_by_prompt" | "session_changed" | "client_disconnected" = reason ===
		"client_disconnected"
			? "client_disconnected"
			: "cancelled_by_client",
	): ProviderAuthCancellationResult {
		const active = this.#active;
		if (!active || active.handle.operationId !== operationId) return "not_found";
		if (active.commitStarted) return "protected";
		active.cancelReason = reason;
		active.cancelCode = code;
		active.abortController.abort(reason);
		this.operations.cancel(active.handle.operationId, reason, code);
		return "cancelled";
	}
	protectedOperationIds(): ReadonlySet<string> {
		const active = this.#active;
		return active?.commitStarted ? new Set([active.handle.operationId]) : new Set();
	}

	cancelAll(
		reason: "user" | "replaced" | "session_transition" | "client_disconnected",
		code: "cancelled_by_client" | "replaced_by_prompt" | "session_changed" | "client_disconnected",
	): ReadonlySet<string> {
		const active = this.#active;
		if (!active) return new Set();
		const result = this.cancel(active.handle.operationId, reason, code);
		return result === "protected" ? new Set([active.handle.operationId]) : new Set();
	}

	close(): ReadonlySet<string> {
		this.#closed = true;
		return this.cancelAll("client_disconnected", "client_disconnected");
	}

	private async run(active: ActiveAuthOperation): Promise<void> {
		if (!this.operations.begin(active.handle)) {
			if (this.#active?.handle.operationId === active.handle.operationId) this.#active = undefined;
			return;
		}
		try {
			const result = await this.service.login(active.providerId, active.method, {
				signal: active.abortController.signal,
				onAuth: info => {
					if (active.abortController.signal.aborted || !this.operations.isActive(active.handle)) return;
					this.output({
						type: "provider_auth_request",
						operationId: active.handle.operationId,
						requestId: Snowflake.next() as string,
						providerId: active.providerId,
						method: "open_url",
						url: info.url,
						launchUrl: info.launchUrl,
						instructions: info.instructions,
					});
				},
				onPrompt: prompt => this.requestSecret(active, prompt),
				onBeforePersist: () => {
					active.commitStarted = true;
				},
			});
			if (!this.operations.isActive(active.handle)) return;
			for (const state of result.states ?? [result.state]) {
				this.output({ type: "provider_auth_update", state });
			}
			this.operations.complete(active.handle, false, { state: result.state });
		} catch (error) {
			if (!this.operations.isActive(active.handle)) return;
			if (active.abortController.signal.aborted) {
				this.operations.cancel(
					active.handle.operationId,
					active.cancelReason ?? "user",
					active.cancelCode ?? "cancelled_by_client",
				);
				return;
			}
			const providerError = error instanceof ProviderAuthError ? error : undefined;
			this.operations.fail(
				active.handle,
				new Error(
					active.commitStarted
						? "Provider authentication persistence outcome is indeterminate; refresh provider state before retrying"
						: (providerError?.message ?? "Provider authentication failed"),
				),
				active.commitStarted
					? "provider_auth_outcome_indeterminate"
					: (providerError?.code ?? "provider_auth_failed"),
			);
		} finally {
			if (this.#active?.handle.operationId === active.handle.operationId) this.#active = undefined;
		}
	}

	private async requestSecret(
		active: ActiveAuthOperation,
		prompt: { message: string; placeholder?: string },
	): Promise<string> {
		if (active.abortController.signal.aborted || !this.operations.isActive(active.handle))
			throw new ProviderAuthError("provider_auth_cancelled", "Provider authentication cancelled");
		const value = await this.requestInput({
			operationId: active.handle.operationId,
			providerId: active.providerId,
			method:
				active.method === "api_key" ? "api_key" : active.method === "paste_code" ? "paste_code" : "secret_text",
			prompt: prompt.message,
			placeholder: prompt.placeholder,
			signal: active.abortController.signal,
		});
		if (value === undefined || active.abortController.signal.aborted || !this.operations.isActive(active.handle))
			throw new ProviderAuthError("provider_auth_cancelled", "Provider authentication cancelled");
		return value;
	}
}
