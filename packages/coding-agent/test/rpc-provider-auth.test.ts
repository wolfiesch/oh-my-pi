import { describe, expect, test } from "bun:test";
import type { CredentialOriginKind } from "@oh-my-pi/pi-ai";
import {
	ProviderAuthController,
	ProviderAuthError,
	ProviderAuthService,
	type ProviderAuthState,
} from "../src/modes/controllers/provider-auth-controller";
import { RpcOperationManager } from "../src/modes/rpc/rpc-operations";

const state = (providerId: string, origin?: CredentialOriginKind): ProviderAuthState => ({
	providerId,
	name: providerId,
	credentialOrigin: origin,
	authenticated: origin !== undefined,
	disabled: false,
	available: true,
	methods: [{ method: "api_key", available: true, exclusive: true }],
});

describe("provider auth controller", () => {
	test("classifies registry-advertised callback, paste, device, and API-key methods", () => {
		const authStorage = {
			hasAuth: () => false,
			getCredentialOrigin: () => undefined,
			getOAuthAccountIdentity: () => undefined,
		};
		const service = new ProviderAuthService({ authStorage, refreshProvider: async () => {} } as never);
		const inventory = service.list();
		expect(
			inventory.find(provider => provider.providerId === "anthropic")?.methods.map(value => value.method),
		).toEqual(["oauth_callback", "paste_code"]);
		expect(
			inventory.find(provider => provider.providerId === "xai-oauth")?.methods.map(value => value.method),
		).toEqual(["device_code"]);
		expect(
			inventory.find(provider => provider.providerId === "openrouter")?.methods.map(value => value.method),
		).toEqual(["api_key"]);
		expect(inventory.find(provider => provider.providerId === "perplexity")?.available).toBeFalse();
	});

	test("consumes an API key once through the secure UI broker without serializing it", async () => {
		const frames: object[] = [];
		const tasks: Promise<void>[] = [];
		let received = "";
		let requestMetadata: object | undefined;
		const fakeService = {
			assertMethod: () => {},
			login: async (
				_provider: string,
				_method: string,
				callbacks: { onPrompt: (prompt: object) => Promise<string> },
			) => {
				received = await callbacks.onPrompt({ message: "API key", placeholder: "sk-..." });
				return { state: state("openrouter", "api_key") };
			},
		};
		const operations = new RpcOperationManager(
			frame => frames.push(frame),
			() => "op-1",
		);
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			operations,
			frame => frames.push(frame),
			task => tasks.push(task),
			async request => {
				requestMetadata = request;
				return "secret-test-key";
			},
		);
		controller.begin("request-1", "openrouter", "api_key");
		expect(frames).toEqual([]);
		expect(() => controller.begin("request-2", "openrouter", "api_key")).toThrow(ProviderAuthError);
		await Promise.all(tasks);
		expect(received).toBe("secret-test-key");
		expect(requestMetadata).toMatchObject({
			operationId: "op-1",
			providerId: "openrouter",
			method: "api_key",
			prompt: "API key",
			placeholder: "sk-...",
		});
		expect(JSON.stringify(frames)).not.toContain("secret-test-key");
		expect(frames.some(frame => "type" in frame && frame.type === "provider_auth_request")).toBeFalse();
		expect(frames.some(frame => "type" in frame && frame.type === "provider_auth_update")).toBeTrue();
	});

	test("completes OAuth callback, paste-code, and device-code registry flows", async () => {
		for (const method of ["oauth_callback", "paste_code", "device_code"] as const) {
			const frames: object[] = [];
			const tasks: Promise<void>[] = [];
			const secureRequests: object[] = [];
			const fakeService = {
				assertMethod: () => {},
				login: async (
					provider: string,
					selected: string,
					callbacks: {
						onAuth: (info: { url: string }) => void;
						onPrompt: (prompt: object) => Promise<string>;
					},
				) => {
					callbacks.onAuth({ url: "https://auth.example.test/start" });
					if (selected === "paste_code") await callbacks.onPrompt({ message: "Paste code" });
					return { state: state(provider, "oauth") };
				},
			};
			const operations = new RpcOperationManager(
				frame => frames.push(frame),
				() => `op-${method}`,
			);
			const controller = new ProviderAuthController(
				fakeService as unknown as ProviderAuthService,
				operations,
				frame => frames.push(frame),
				task => tasks.push(task),
				async request => {
					secureRequests.push(request);
					return "one-time-code";
				},
			);
			controller.begin(undefined, "anthropic", method);
			await Promise.all(tasks);
			expect(frames).toContainEqual(expect.objectContaining({ type: "provider_auth_request", method: "open_url" }));
			expect(secureRequests).toHaveLength(method === "paste_code" ? 1 : 0);
			expect(JSON.stringify(frames)).not.toContain("one-time-code");
			expect(frames).toContainEqual(expect.objectContaining({ type: "operation_completed" }));
		}
	});

	test("scrubs provider failures", async () => {
		const frames: object[] = [];
		const tasks: Promise<void>[] = [];
		const fakeService = {
			assertMethod: () => {},
			login: async () => {
				throw new Error("upstream rejected token=secret-provider-token");
			},
		};
		const operations = new RpcOperationManager(
			frame => frames.push(frame),
			() => "op-fail",
		);
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			operations,
			frame => frames.push(frame),
			task => tasks.push(task),
			async () => "unused",
		);
		controller.begin(undefined, "openrouter", "api_key");
		await Promise.all(tasks);
		expect(JSON.stringify(frames)).not.toContain("secret-provider-token");
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "operation_failed", code: "provider_auth_failed" }),
		);
	});

	test("fails closed when secure input is cancelled", async () => {
		const frames: object[] = [];
		const tasks: Promise<void>[] = [];
		const fakeService = {
			assertMethod: () => {},
			login: async (
				_provider: string,
				_method: string,
				callbacks: { onPrompt: (prompt: object) => Promise<string> },
			) => {
				await callbacks.onPrompt({ message: "API key" });
				return { state: state("openrouter", "api_key") };
			},
		};
		const operations = new RpcOperationManager(
			frame => frames.push(frame),
			() => "op-no-input",
		);
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			operations,
			frame => frames.push(frame),
			task => tasks.push(task),
			async () => undefined,
		);
		controller.begin(undefined, "openrouter", "api_key");
		await Promise.all(tasks);
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "operation_failed", code: "provider_auth_cancelled" }),
		);
	});

	test("cancel and disconnect abort pending secure input and cannot complete", async () => {
		for (const disconnect of [false, true]) {
			const frames: object[] = [];
			const tasks: Promise<void>[] = [];
			const fakeService = {
				assertMethod: () => {},
				login: async (
					_provider: string,
					_method: string,
					callbacks: { onPrompt: (prompt: object) => Promise<string> },
				) => {
					await callbacks.onPrompt({ message: "Paste code" });
					return { state: state("anthropic", "oauth") };
				},
			};
			const operations = new RpcOperationManager(
				frame => frames.push(frame),
				() => "op-cancel",
			);
			const controller = new ProviderAuthController(
				fakeService as unknown as ProviderAuthService,
				operations,
				frame => frames.push(frame),
				task => tasks.push(task),
				request =>
					new Promise(resolve => {
						if (request.signal.aborted) resolve(undefined);
						else request.signal.addEventListener("abort", () => resolve(undefined), { once: true });
					}),
			);
			controller.begin(undefined, "anthropic", "paste_code");
			await Promise.resolve();
			if (disconnect) controller.close();
			else await controller.cancel("op-cancel");
			await Promise.all(tasks);
			expect(frames.some(frame => "type" in frame && frame.type === "provider_auth_update")).toBeFalse();
			expect(frames).toContainEqual(
				expect.objectContaining({
					type: "operation_cancelled",
					reason: disconnect ? "client_disconnected" : "user",
				}),
			);
		}
	});

	test("operation-wide cancellation aborts provider work and retains exclusivity until cleanup", async () => {
		const frames: object[] = [];
		const tasks: Promise<void>[] = [];
		let releaseProvider!: () => void;
		let committed = false;
		let providerSignal: AbortSignal | undefined;
		const providerReleased = new Promise<void>(resolve => {
			releaseProvider = resolve;
		});
		const fakeService = {
			assertMethod: () => {},
			login: async (provider: string, _method: string, callbacks: { signal: AbortSignal }) => {
				await providerReleased;
				providerSignal = callbacks.signal;
				if (callbacks.signal.aborted) throw new Error("provider aborted");
				committed = true;
				return { state: state(provider, "api_key") };
			},
		};
		let nextOperation = 0;
		const operations = new RpcOperationManager(
			frame => frames.push(frame),
			() => `op-wide-${++nextOperation}`,
		);
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			operations,
			frame => frames.push(frame),
			task => tasks.push(task),
			async () => "unused",
		);
		controller.begin(undefined, "openrouter", "api_key");
		await Promise.resolve();
		controller.cancelAll("replaced", "replaced_by_prompt");
		expect(() => controller.begin(undefined, "anthropic", "api_key")).toThrow(
			expect.objectContaining({ code: "provider_auth_busy" }),
		);
		releaseProvider();
		await tasks[0];
		expect(committed).toBeFalse();
		expect(providerSignal).toBeUndefined();
		expect(frames.some(frame => "type" in frame && frame.type === "provider_auth_update")).toBeFalse();
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "operation_cancelled",
				operationId: "op-wide-1",
				reason: "replaced",
				code: "replaced_by_prompt",
			}),
		);
		controller.begin(undefined, "anthropic", "api_key");
		await Promise.all(tasks);
		expect(committed).toBeTrue();
	});

	test("rejects cancellation after the persistence commit boundary", async () => {
		const frames: object[] = [];
		const tasks: Promise<void>[] = [];
		let releasePersistence!: () => void;
		let markCommitStarted!: () => void;
		const persistenceReleased = new Promise<void>(resolve => {
			releasePersistence = resolve;
		});
		const commitStarted = new Promise<void>(resolve => {
			markCommitStarted = resolve;
		});
		const fakeService = {
			assertMethod: () => {},
			login: async (provider: string, _method: string, callbacks: { onBeforePersist?: () => void }) => {
				callbacks.onBeforePersist?.();
				markCommitStarted();
				await persistenceReleased;
				return { state: state(provider, "api_key") };
			},
		};
		const operations = new RpcOperationManager(
			frame => frames.push(frame),
			() => "op-commit",
		);
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			operations,
			frame => frames.push(frame),
			task => tasks.push(task),
			async () => "unused",
		);

		controller.begin(undefined, "openrouter", "api_key");
		await commitStarted;
		expect(controller.cancel("op-commit")).toBe("protected");
		releasePersistence();
		await Promise.all(tasks);

		expect(frames).toContainEqual(expect.objectContaining({ type: "operation_completed", operationId: "op-commit" }));
		expect(frames.some(frame => "type" in frame && frame.type === "operation_cancelled")).toBeFalse();
	});

	test("reports an indeterminate outcome when persistence loses its acknowledgement", async () => {
		const frames: object[] = [];
		const tasks: Promise<void>[] = [];
		const fakeService = {
			assertMethod: () => {},
			login: async (_provider: string, _method: string, callbacks: { onBeforePersist?: () => void }) => {
				callbacks.onBeforePersist?.();
				throw new Error("broker acknowledgement timed out");
			},
		};
		const operations = new RpcOperationManager(
			frame => frames.push(frame),
			() => "op-indeterminate",
		);
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			operations,
			frame => frames.push(frame),
			task => tasks.push(task),
			async () => "unused",
		);

		controller.begin(undefined, "openrouter", "api_key");
		await Promise.all(tasks);

		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "operation_failed",
				operationId: "op-indeterminate",
				code: "provider_auth_outcome_indeterminate",
			}),
		);
	});
	test("reserves provider mutation across confirmation and blocks concurrent login", async () => {
		const tasks: Promise<void>[] = [];
		const fakeService = {
			assertMethod: () => {},
			login: async () => ({ state: state("openrouter", "api_key") }),
		};
		const controller = new ProviderAuthController(
			fakeService as unknown as ProviderAuthService,
			new RpcOperationManager(
				() => {},
				() => "op-after-removal",
			),
			() => {},
			task => tasks.push(task),
			async () => "unused",
		);

		const release = controller.reserveMutation();
		expect(controller.hasMutationInFlight()).toBeTrue();
		expect(() => controller.begin(undefined, "openrouter", "api_key")).toThrow(
			expect.objectContaining({ code: "provider_auth_busy" }),
		);
		release();
		expect(controller.hasMutationInFlight()).toBeFalse();
		controller.begin(undefined, "openrouter", "api_key");
		await Promise.all(tasks);
	});
});

describe("provider auth removal", () => {
	test("removes stored origins and refuses env/runtime/config/fallback origins", async () => {
		let origin: CredentialOriginKind | undefined = "api_key";
		let removed = 0;
		const authStorage = {
			hasAuth: () => origin !== undefined,
			getCredentialOrigin: () => (origin ? { kind: origin } : undefined),
			getOAuthAccountIdentity: () => undefined,
			remove: async () => {
				removed += 1;
				origin = undefined;
			},
		};
		const service = new ProviderAuthService({ authStorage, refreshProvider: async () => {} } as never);
		expect((await service.remove("openrouter")).state.authenticated).toBeFalse();
		expect(removed).toBe(1);
		for (const blocked of ["env", "runtime", "config", "fallback"] as const) {
			origin = blocked;
			await expect(service.remove("openrouter")).rejects.toMatchObject({
				code: "provider_auth_origin_not_removable",
			});
		}
		expect(removed).toBe(1);
	});

	test("removes aliased credentials from canonical storage and refreshes every affected provider", async () => {
		const removed: string[] = [];
		const refreshed: string[] = [];
		let stored = true;
		const authStorage = {
			hasAuth: (providerId: string) => providerId === "openai-codex" && stored,
			getCredentialOrigin: (providerId: string) =>
				providerId === "openai-codex" && stored ? { kind: "oauth" as const } : undefined,
			getOAuthAccountIdentity: () => undefined,
			remove: async (providerId: string) => {
				removed.push(providerId);
				stored = false;
			},
		};
		const service = new ProviderAuthService({
			authStorage,
			refreshProvider: async (providerId: string) => {
				refreshed.push(providerId);
			},
		} as never);

		expect(service.credentialTarget("openai-codex-device")).toEqual({
			storageProvider: "openai-codex",
			affectedProviderIds: ["openai-codex", "openai-codex-device"],
		});
		const result = await service.remove("openai-codex-device");
		expect(removed).toEqual(["openai-codex"]);
		expect(refreshed).toEqual(["openai-codex", "openai-codex-device"]);
		expect(result.states.map(item => item.providerId)).toEqual(["openai-codex", "openai-codex-device"]);
		expect(result.states.every(item => !item.authenticated)).toBeTrue();
	});

	test("reports successful removal when provider refresh fails afterward", async () => {
		let origin: CredentialOriginKind | undefined = "api_key";
		const authStorage = {
			hasAuth: () => origin !== undefined,
			getCredentialOrigin: () => (origin ? { kind: origin } : undefined),
			getOAuthAccountIdentity: () => undefined,
			remove: async () => {
				origin = undefined;
			},
		};
		const service = new ProviderAuthService({
			authStorage,
			refreshProvider: async () => {
				throw new Error("offline");
			},
		} as never);
		const result = await service.remove("openrouter");
		expect(result.state.authenticated).toBeFalse();
		expect(origin).toBeUndefined();
	});
});
