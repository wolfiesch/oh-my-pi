import { describe, expect, it } from "bun:test";
import { isCmuxUnavailableError, resolveCmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("resolveCmuxKind", () => {
	it("returns a cmux kind from environment socket settings", () => {
		expect(
			resolveCmuxKind(null, {
				CMUX_SOCKET_PATH: "/tmp/cmux.sock",
				CMUX_SOCKET_PASSWORD: "pw",
			}),
		).toEqual({
			kind: "cmux",
			socketPath: "/tmp/cmux.sock",
			password: "pw",
			surface: undefined,
		});
	});

	it("includes the requested surface UUID", () => {
		expect(resolveCmuxKind({ surface: "surface-uuid" }, { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toEqual({
			kind: "cmux",
			socketPath: "/tmp/cmux.sock",
			password: undefined,
			surface: "surface-uuid",
		});
	});

	it("returns null when cmux environment is absent", () => {
		expect(resolveCmuxKind(null, {})).toBeNull();
	});

	it("PI_BROWSER_CMUX=0 disables cmux even when the socket environment is present", () => {
		expect(resolveCmuxKind(null, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", PI_BROWSER_CMUX: "0" })).toBeNull();
	});

	it("PI_BROWSER_CMUX=1 enables cmux over a disabled setting", () => {
		expect(
			resolveCmuxKind({ settingEnabled: false }, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", PI_BROWSER_CMUX: "1" }),
		).toEqual({
			kind: "cmux",
			socketPath: "/tmp/cmux.sock",
			password: undefined,
			surface: undefined,
		});
	});

	it("settings can disable cmux when the env override is unset", () => {
		expect(resolveCmuxKind({ settingEnabled: false }, { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toBeNull();
	});
});

describe("isCmuxUnavailableError", () => {
	it("recognizes stale sockets and missing browser surfaces", () => {
		expect(isCmuxUnavailableError(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }))).toBe(true);
		expect(isCmuxUnavailableError(new Error("cmux browser.open_split did not return a surface_id"))).toBe(true);
	});

	it("does not retry ordinary page failures on another backend", () => {
		expect(isCmuxUnavailableError(new Error("Navigation failed: net::ERR_NAME_NOT_RESOLVED"))).toBe(false);
	});
});
