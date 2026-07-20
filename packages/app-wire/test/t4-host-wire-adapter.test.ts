import { describe, expect, test } from "bun:test";
import { decodeClientFrame, hostId, sessionId } from "@oh-my-pi/app-wire";

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
});
