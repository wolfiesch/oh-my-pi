#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, echoes each inbound command with a
 * success response, and stays alive until stdin closes or SIGTERM arrives.
 * Used by rpc-client lifecycle tests that need to exercise start/stop/start
 * without booting the full agent runtime (which requires provider credentials).
 */
if (Bun.env.MOCK_RPC_PID_FILE) {
	await Bun.write(Bun.env.MOCK_RPC_PID_FILE, String(process.pid));
}
if (Bun.env.MOCK_RPC_IGNORE_SIGTERM === "1") {
	process.on("SIGTERM", () => {});
}

const supportsProtocolV2 = Bun.env.MOCK_RPC_V2 === "1";
const legacyState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "mock-session",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};

if (Bun.env.MOCK_RPC_EXIT_BEFORE_READY) {
	const message = Bun.env.MOCK_RPC_EXIT_STDERR ?? "";
	if (message) {
		// Await the pipe write: exiting immediately can drop unflushed stderr
		// bytes, leaving the client's startup error without the failure text.
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stderr.write(message, () => resolve());
		await promise;
	}
	process.exit(Number(Bun.env.MOCK_RPC_EXIT_BEFORE_READY));
}

let protocolV2Enabled = false;
process.stdout.write(
	`${JSON.stringify(
		supportsProtocolV2
			? {
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				}
			: { type: "ready" },
	)}\n`,
);

function writeFrame(frame: Record<string, unknown>): void {
	const logical = Buffer.from(JSON.stringify(frame), "utf8");
	if (!protocolV2Enabled || logical.byteLength <= 1024 * 1024) {
		process.stdout.write(`${logical.toString("utf8")}\n`);
		return;
	}
	const chunkBytes = 256 * 1024;
	const count = Math.ceil(logical.byteLength / chunkBytes);
	for (let index = 0; index < count; index++) {
		process.stdout.write(
			`${JSON.stringify({
				type: "rpc_chunk",
				chunkId: "mock-rpc-v2",
				index,
				count,
				byteLength: logical.byteLength,
				data: logical.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
			})}\n`,
		);
	}
}

if (Bun.env.MOCK_RPC_CLIENT_FRAMES === "1") {
	writeFrame({ type: "command_output", text: "extension output" });
	writeFrame({ type: "session_info_update", title: "RPC test", sessionId: "session-1" });
	writeFrame({ type: "config_update", thinkingLevel: "high" });
	writeFrame({
		type: "extension_error",
		extensionPath: "/tmp/example-extension.ts",
		event: "session_start",
		error: "fixture failure",
	});
	writeFrame({
		type: "extension_ui_request",
		id: "ui-confirm-1",
		method: "confirm",
		title: "Continue?",
		message: "Proceed with the fixture?",
	});
	writeFrame({
		type: "host_uri_request",
		id: "host-uri-1",
		operation: Bun.env.MOCK_RPC_MALFORMED_HOST_URI_WRITE === "1" ? "write" : "read",
		url: "fixture://resource/1",
	});
	if (Bun.env.MOCK_RPC_HOST_URI_CANCEL === "1") {
		setTimeout(() => {
			writeFrame({
				type: "host_uri_cancel",
				id: "host-uri-cancel-1",
				targetId: "host-uri-1",
			});
		}, 25);
	}
	writeFrame({ type: "future_server_frame", value: 1 });
}

const captureFile = Bun.env.MOCK_RPC_CAPTURE_FILE;
let captureText = "";
let operationSequence = 0;
const activeOperations = new Map<string, { requestId: string | undefined; timer?: Timer }>();
const recentOperations = new Map<string, Record<string, unknown>>();
let continuationStateReads = 0;

// Bun's `console` is an AsyncIterable over stdin lines.
for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (frame && typeof frame === "object" && typeof frame.type === "string") {
			if (captureFile) {
				captureText += `${JSON.stringify(frame)}\n`;
				await Bun.write(captureFile, captureText);
			}
			if (Bun.env.MOCK_RPC_EXIT_ON_COMMAND) {
				process.stderr.write(Bun.env.MOCK_RPC_EXIT_STDERR ?? "");
				process.exit(Number(Bun.env.MOCK_RPC_EXIT_ON_COMMAND));
			}
			if (Bun.env.MOCK_RPC_INVALID_OUTPUT === "1") {
				process.stdout.write("{invalid-json\n");
				continue;
			}
			if (Bun.env.MOCK_RPC_IGNORE_COMMANDS === "1") continue;
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (frame.type === "negotiate_protocol" && frame.protocolVersion === 2) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { protocolVersion: 2 },
				});
				protocolV2Enabled = true;
				continue;
			}
			if (frame.type === "get_settings") {
				// Deterministic stand-in for the real snapshot: one disclosed entry and
				// one redacted entry, so a client test can assert both shapes.
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						// Echoed so a client test can prove the tab argument is actually sent.
						requestedTab: typeof frame.tab === "string" ? frame.tab : null,
						settings: [
							{
								path: "colorBlindMode",
								type: "boolean",
								default: false,
								value: true,
								configured: true,
							},
							{ path: "auth.broker.token", type: "string", redacted: true },
						],
					},
				});
				continue;
			}
			if (frame.type === "get_messages_page") {
				if (Bun.env.MOCK_RPC_PAGE_BUSY === "1") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "Cannot page messages while the session is changing",
						code: "session_busy",
					});
					continue;
				}
				if (Bun.env.MOCK_RPC_PAGE_STALE === "1" && frame.cursor !== undefined) {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "RPC message cursor is stale",
						code: "stale_cursor",
					});
					continue;
				}
				const first = frame.cursor === undefined;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: first
						? {
								messages: [{ role: "user", content: "first", timestamp: 1 }],
								nextCursor: "second-page",
								totalMessages: 2,
							}
						: {
								messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 }],
								totalMessages: 2,
							},
				});
				continue;
			}
			if (
				frame.type === "get_messages" &&
				(Bun.env.MOCK_RPC_PAGE_BUSY === "1" || Bun.env.MOCK_RPC_PAGE_STALE === "1")
			) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
						],
					},
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_CONTINUATION_RACE === "1" && frame.type === "follow_up") {
				writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				setTimeout(() => {
					writeFrame({ type: "agent_end", messages: [], isTerminal: true });
				}, 5);
				continue;
			}
			if (Bun.env.MOCK_RPC_CONTINUATION_RACE === "1" && frame.type === "get_state") {
				if (Bun.env.MOCK_RPC_STALL_CONTINUATION_STATE === "1") continue;
				continuationStateReads++;
				const idle = continuationStateReads > 1;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						...legacyState,
						activityPhase: idle ? "idle" : "maintenance",
						queuedMessageCount: idle ? 0 : 1,
					},
				});
				continue;
			}
			if (
				frame.type === "get_state" &&
				(Bun.env.MOCK_RPC_LEGACY_STATE === "1" ||
					Bun.env.MOCK_RPC_LEGACY_STREAMING === "1" ||
					Bun.env.MOCK_RPC_INVALID_TPS === "1" ||
					Bun.env.MOCK_RPC_ADVISOR_STATE === "1" ||
					Bun.env.MOCK_RPC_INVALID_ADVISOR === "1" ||
					Bun.env.MOCK_RPC_FUTURE_ADVISOR_STATUS === "1" ||
					Bun.env.MOCK_RPC_ACTIVITY_PHASE)
			) {
				const data = {
					...legacyState,
					...(Bun.env.MOCK_RPC_LEGACY_STREAMING === "1" ? { isStreaming: true } : {}),
					...(Bun.env.MOCK_RPC_INVALID_TPS === "1"
						? { fastModeEnabled: false, fastModeActive: false, tokensPerSecond: "invalid" }
						: {}),
					...(Bun.env.MOCK_RPC_ACTIVITY_PHASE ? { activityPhase: Bun.env.MOCK_RPC_ACTIVITY_PHASE } : {}),
					...(Bun.env.MOCK_RPC_ADVISOR_STATE === "1"
						? {
								advisor: {
									configured: true,
									active: false,
									advisors: [{ name: "reviewer", status: "no_model" }],
								},
							}
						: {}),
					...(Bun.env.MOCK_RPC_INVALID_ADVISOR === "1" ? { advisor: {} } : {}),
					...(Bun.env.MOCK_RPC_FUTURE_ADVISOR_STATUS === "1"
						? {
								advisor: {
									configured: true,
									active: true,
									advisors: [{ name: "reviewer", status: "future_status" }],
								},
							}
						: {}),
				};
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data,
				});
				continue;
			}
			if (frame.type === "get_advisor_state" || frame.type === "set_advisor_enabled") {
				if (Bun.env.MOCK_RPC_INVALID_ADVISOR === "1") {
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}
				if (Bun.env.MOCK_RPC_FUTURE_ADVISOR_STATUS === "1") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: true,
						data: {
							configured: true,
							active: true,
							advisors: [{ name: "reviewer", status: "future_status" }],
						},
					});
					continue;
				}
				const configured = frame.type === "get_advisor_state" || frame.enabled === true;
				const advisor = {
					configured,
					active: false,
					advisors: [{ name: "reviewer", status: configured ? "no_model" : "paused" }],
				};
				if (frame.type === "set_advisor_enabled") writeFrame({ type: "config_update", advisor });
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: advisor,
				});
				continue;
			}

			if (Bun.env.MOCK_RPC_CLIENT_FRAMES === "1" && frame.type === "set_todos") {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { todoPhases: frame.phases },
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_REJECT_SESSION_NAME === "1" && frame.type === "set_session_name") {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: false,
					error: "Session name cannot be empty",
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_CLIENT_FRAMES === "1" && frame.type === "set_host_uri_schemes") {
				const schemes = Array.isArray(frame.schemes)
					? frame.schemes
							.map(scheme => (scheme && typeof scheme === "object" ? Reflect.get(scheme, "scheme") : undefined))
							.filter((scheme): scheme is string => typeof scheme === "string")
					: [];
				if (Bun.env.MOCK_RPC_REJECT_HOST_URI_SCHEME && schemes.includes(Bun.env.MOCK_RPC_REJECT_HOST_URI_SCHEME)) {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: `Host URI scheme rejected by fixture: ${Bun.env.MOCK_RPC_REJECT_HOST_URI_SCHEME}`,
					});
					continue;
				}
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { schemes },
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_OPERATIONS === "1" && frame.type === "cancel_operation") {
				const operationId = String(frame.operationId);
				const active = activeOperations.get(operationId);
				let terminal = recentOperations.get(operationId);
				if (active) {
					clearTimeout(active.timer);
					activeOperations.delete(operationId);
					terminal = {
						type: "operation_cancelled",
						operationId,
						requestId: active.requestId,
						command: "prompt",
						reason: "user",
						code: "cancelled_by_client",
						settledAt: Date.now(),
					};
					recentOperations.set(operationId, terminal);
					writeFrame(terminal);
				}
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: terminal
						? {
								operationId,
								status:
									terminal.type === "operation_cancelled"
										? "cancelled"
										: terminal.type === "operation_completed"
											? "completed"
											: "failed",
								terminal,
							}
						: { operationId, status: "not_found" },
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_OPERATIONS === "1" && frame.type === "get_operations") {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						active: Array.from(activeOperations, ([operationId, operation]) => ({
							operationId,
							requestId: operation.requestId,
							command: "prompt",
							status: "started",
							acceptedAt: Date.now(),
							startedAt: Date.now(),
						})),
						recent: Array.from(recentOperations.values()),
					},
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_OPERATIONS === "1" && frame.type === "prompt") {
				const operationId = `operation-${++operationSequence}`;
				const active = { requestId: id, timer: undefined as Timer | undefined };
				activeOperations.set(operationId, active);
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { operationId, accepted: true },
				});
				writeFrame({
					type: "operation_started",
					operationId,
					requestId: id,
					command: "prompt",
					startedAt: Date.now(),
				});
				if (frame.message === "hold") continue;
				active.timer = setTimeout(() => {
					if (!activeOperations.delete(operationId)) return;
					let terminal: Record<string, unknown>;
					if (frame.message === "local") {
						terminal = {
							type: "operation_completed",
							operationId,
							requestId: id,
							command: "prompt",
							agentInvoked: false,
							settledAt: Date.now(),
						};
					} else if (frame.message === "fail") {
						terminal = {
							type: "operation_failed",
							operationId,
							requestId: id,
							command: "prompt",
							error: "fixture scheduling failure",
							code: "prompt_scheduling_failed",
							settledAt: Date.now(),
						};
					} else {
						writeFrame({ type: "agent_start" });
						writeFrame({ type: "agent_end", messages: [], isTerminal: false });
						writeFrame({ type: "agent_end", messages: [], isTerminal: true });
						terminal = {
							type: "operation_completed",
							operationId,
							requestId: id,
							command: "prompt",
							agentInvoked: true,
							settledAt: Date.now(),
						};
					}
					recentOperations.set(operationId, terminal);
					writeFrame(terminal);
				}, 5);
				continue;
			}
			const localPrompt =
				frame.type === "prompt" &&
				(Bun.env.MOCK_RPC_LOCAL_PROMPT_RESPONSE === "1" ||
					(Bun.env.MOCK_RPC_MIXED_PROMPT_RESULTS === "1" && frame.message === "/local-only"));
			writeFrame({
				id,
				type: "response",
				command: frame.type,
				success: true,
				data: localPrompt ? { agentInvoked: false } : supportsProtocolV2 ? { payload: "😀".repeat(270_000) } : {},
			});
			if (Bun.env.MOCK_RPC_CLIENT_FRAMES === "1" && frame.type === "prompt" && !localPrompt) {
				writeFrame({ type: "prompt_result", id, agentInvoked: true });
				writeFrame({ type: "agent_end", messages: [], isTerminal: false });
				setTimeout(() => {
					writeFrame({ type: "agent_end", messages: [], isTerminal: true });
				}, 75);
			}
		}
	} catch {
		// ignore parse errors — the test harness sends well-formed frames.
	}
}
process.exit(0);
