import type { Mock } from "bun:test";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import {
	resolveProfileLaunchEnv,
	resolveToolLaunch,
	TOOL_DESCRIPTORS,
} from "@oh-my-pi/pi-coding-agent/home/launcher-service";

describe("home launcher contract", () => {
	let homedirSpy: Mock<() => string>;

	afterEach(() => {
		homedirSpy?.mockRestore();
	});

	it("TOOL_DESCRIPTORS has correct profileScoped flags", () => {
		expect(TOOL_DESCRIPTORS.stats.profileScoped).toBe(true);
		expect(Object.hasOwn(TOOL_DESCRIPTORS, "mechanism")).toBe(false);
		expect(TOOL_DESCRIPTORS.collab.profileScoped).toBe(false);
		expect(TOOL_DESCRIPTORS.robomp.profileScoped).toBe(false);
	});

	it("resolveProfileLaunchEnv correctly parses ~/.omp/agent", () => {
		homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/mockuser");
		const env = resolveProfileLaunchEnv({
			agentDir: "/home/mockuser/.omp/agent",
		});
		expect(env).toEqual({
			PI_CODING_AGENT_DIR: "/home/mockuser/.omp/agent",
			PI_CONFIG_DIR: ".omp",
		});
	});

	it("resolveProfileLaunchEnv correctly parses ~/.config/omp-giga-personal/agent", () => {
		homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/mockuser");
		const env = resolveProfileLaunchEnv({
			agentDir: "/home/mockuser/.config/omp-giga-personal/agent",
		});
		expect(env).toEqual({
			PI_CODING_AGENT_DIR: "/home/mockuser/.config/omp-giga-personal/agent",
			PI_CONFIG_DIR: ".config/omp-giga-personal",
		});
	});

	it("resolveProfileLaunchEnv correctly parses ~/.omp/profiles/work/agent", () => {
		homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/mockuser");
		const env = resolveProfileLaunchEnv({
			agentDir: "/home/mockuser/.omp/profiles/work/agent",
		});
		expect(env).toEqual({
			PI_CODING_AGENT_DIR: "/home/mockuser/.omp/profiles/work/agent",
			OMP_PROFILE: "work",
		});
	});

	it("resolveToolLaunch resolves valid launch spec for stats only among profile tools", () => {
		const env = { OMP_PROFILE: "test" };
		const statsSpec = resolveToolLaunch("stats", 3847, env);
		expect(statsSpec).not.toBeNull();
		expect(statsSpec?.cmd).toBe(process.execPath);
		expect(statsSpec?.args).toContain("stats");
		expect(statsSpec?.args).toContain("--port");
		expect(statsSpec?.args).toContain("3847");
		expect(statsSpec?.env).toEqual(env);
	});

	it("resolveToolLaunch returns valid spec for collab when repo structure is present", () => {
		const collabSpec = resolveToolLaunch("collab", 7466, {});
		expect(collabSpec).not.toBeNull();
		expect(collabSpec?.cmd).toBe("bun");
		expect(collabSpec?.args).toContain("--port");
		expect(collabSpec?.args).toContain("7466");
		expect(collabSpec?.args[0]).toContain("local-relay.ts");
	});

	it("resolveToolLaunch returns null when repo structure is simulated as missing", () => {
		const statSyncSpy = spyOn(fs, "statSync").mockImplementation(() => {
			throw new Error("ENOENT");
		});

		try {
			const collabSpec = resolveToolLaunch("collab", 7466, {});
			expect(collabSpec).toBeNull();
		} finally {
			statSyncSpy.mockRestore();
		}
	});
});
