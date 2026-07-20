import { describe, expect, test } from "bun:test";
import { decodeClientFrame, hostId, sessionId } from "@oh-my-pi/app-wire";
import { decodeCommandArguments } from "@oh-my-pi/app-wire/command.js";

describe("T4 host-wire compatibility export", () => {
	test("decodes the negotiated transcript page command", () => {
		expect(
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "page-request",
				commandId: "page-command",
				hostId: hostId("page-host"),
				sessionId: sessionId("page-session"),
				command: "transcript.page",
				args: { limit: 64, maxBytes: 256 * 1024 },
			}),
		).toMatchObject({ command: "transcript.page", args: { limit: 64, maxBytes: 256 * 1024 } });
	});

	test("preserves direct module import paths", () => {
		expect(decodeCommandArguments("transcript.page", { limit: 64, maxBytes: 256 * 1024 })).toEqual({
			limit: 64,
			maxBytes: 256 * 1024,
		});
	});
});
