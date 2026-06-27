import { describe, expect, it } from "bun:test";
import { buildResumeCommand } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";

const UUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("buildResumeCommand", () => {
	it("prefers the shell-safe session id when resolvable", () => {
		expect(buildResumeCommand({ sessionId: UUID, sessionFile: "/tmp/x.jsonl", idResolvable: true })).toBe(
			`omp --resume ${UUID}`,
		);
	});

	it("uses the bare id form identically across platforms (id has no metacharacters)", () => {
		expect(buildResumeCommand({ sessionId: UUID, idResolvable: true }, "win32")).toBe(`omp --resume ${UUID}`);
		expect(buildResumeCommand({ sessionId: UUID, idResolvable: true }, "linux")).toBe(`omp --resume ${UUID}`);
	});

	it("falls back to a POSIX single-quoted path when the id is not resolvable", () => {
		expect(
			buildResumeCommand({ sessionId: UUID, sessionFile: "/tmp/My Sessions/x.jsonl", idResolvable: false }, "linux"),
		).toBe("omp --resume '/tmp/My Sessions/x.jsonl'");
	});

	it("neutralizes shell metacharacters in the POSIX path fallback", () => {
		expect(buildResumeCommand({ sessionFile: "/tmp/$(rm -rf ~)/x.jsonl" }, "linux")).toBe(
			"omp --resume '/tmp/$(rm -rf ~)/x.jsonl'",
		);
		expect(buildResumeCommand({ sessionFile: "/tmp/`whoami`/x.jsonl" }, "linux")).toBe(
			"omp --resume '/tmp/`whoami`/x.jsonl'",
		);
		expect(buildResumeCommand({ sessionFile: "/tmp/it's mine/x.jsonl" }, "linux")).toBe(
			"omp --resume '/tmp/it'\\''s mine/x.jsonl'",
		);
	});

	it("suppresses the path fallback on win32 where no single quoting is safe for cmd and PowerShell", () => {
		// Windows filenames can contain $ and `, which PowerShell expands inside
		// double quotes, and cmd.exe does not honor single quotes — so there is no
		// safe generic path command. Emit nothing rather than an injectable string.
		expect(
			buildResumeCommand({ sessionFile: "C:\\tmp\\$(calc)\\x.jsonl", idResolvable: false }, "win32"),
		).toBeUndefined();
		expect(buildResumeCommand({ sessionFile: "C:\\tmp\\a b.jsonl" }, "win32")).toBeUndefined();
	});

	it("returns undefined when neither a resolvable id nor a usable path is available", () => {
		expect(buildResumeCommand({}, "linux")).toBeUndefined();
		expect(buildResumeCommand({ sessionId: UUID, idResolvable: false }, "win32")).toBeUndefined();
	});
});
