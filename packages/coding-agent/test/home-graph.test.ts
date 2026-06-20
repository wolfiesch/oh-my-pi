import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addApiKeyCredential } from "@oh-my-pi/pi-coding-agent/home/auth-service";
import { buildGraph } from "@oh-my-pi/pi-coding-agent/home/graph-service";
import * as piUtils from "@oh-my-pi/pi-utils";

describe("home graph contract", () => {
	let tempDir: string;
	let getConfigRootDirSpy: Mock<() => string>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-home-graph-test-"));
		getConfigRootDirSpy = spyOn(piUtils, "getConfigRootDir").mockReturnValue(tempDir);

		// 1. Create the home/profiles.json file.
		const profilesDir = path.join(tempDir, "home");
		await fs.mkdir(profilesDir, { recursive: true });

		const agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });

		const profilesJson = {
			version: 1,
			profiles: [
				{
					id: "test-profile",
					label: "Test Profile",
					agentDir: agentDir,
				},
			],
		};
		await fs.writeFile(path.join(profilesDir, "profiles.json"), JSON.stringify(profilesJson, null, 2));

		// 2. Create agent folder structure & config.yml
		const agentsDir = path.join(agentDir, "agents");
		await fs.mkdir(agentsDir, { recursive: true });

		const configYaml = `
modelRoles:
  default: openai/gpt-4o:high
  coder: anthropic/claude-3-5-sonnet
cycleOrder:
  - default
  - coder
retry:
  fallbackChains:
    default:
      - anthropic/claude-3-5-sonnet
`;
		await fs.writeFile(path.join(agentDir, "config.yml"), configYaml.trim());

		// 3. Write user agent definition
		const agentMd = `---
name: Reviewer
description: Review code changes.
model:
  - pi/default
---
This is the reviewer agent.
`;
		await fs.writeFile(path.join(agentsDir, "reviewer.md"), agentMd.trim());
	});

	afterEach(async () => {
		getConfigRootDirSpy?.mockRestore();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("builds the graph with relation tags, cycleIndex, and auth metadata", async () => {
		// Mock provider key for openai to test auth metadata
		await addApiKeyCredential("test-profile", "openai", "sk-test12345");

		const projectDir = path.join(tempDir, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });

		// Build graph
		const graph = await buildGraph("test-profile", projectDir);

		// 1. Assert role nodes and cycleIndex
		const roleDefault = graph.nodes.find(n => n.id === "role:default");
		expect(roleDefault).toBeDefined();
		expect(roleDefault?.kind).toBe("role");
		expect(roleDefault?.inCycle).toBe(true);
		expect(roleDefault?.cycleIndex).toBe(0);

		const roleCoder = graph.nodes.find(n => n.id === "role:coder");
		expect(roleCoder).toBeDefined();
		expect(roleCoder?.kind).toBe("role");
		expect(roleCoder?.inCycle).toBe(true);
		expect(roleCoder?.cycleIndex).toBe(1);

		// 2. Assert agent node
		const agentReviewer = graph.nodes.find(n => n.id === "agent:Reviewer");
		expect(agentReviewer).toBeDefined();
		expect(agentReviewer?.kind).toBe("agent");
		expect(agentReviewer?.label).toBe("Reviewer");
		expect(agentReviewer?.meta?.agentSource).toBe("user");

		// 3. Assert provider auth metadata
		const providerOpenai = graph.nodes.find(n => n.id === "provider:openai");
		expect(providerOpenai).toBeDefined();
		expect(providerOpenai?.kind).toBe("provider");
		expect(providerOpenai?.originKind).toBe("api_key");
		expect(providerOpenai?.meta?.providerOrigin).toBe("api_key");
		expect(providerOpenai?.meta?.authStatus).toBe("ok");

		const providerAnthropic = graph.nodes.find(n => n.id === "provider:anthropic");
		expect(providerAnthropic).toBeDefined();
		expect(providerAnthropic?.kind).toBe("provider");
		expect(providerAnthropic?.originKind).toBe("none");
		expect(providerAnthropic?.meta?.providerOrigin).toBe("none");
		expect(providerAnthropic?.meta?.authStatus).toBe("none");

		// 4. Assert relation tags on edges
		// Role-model edge
		const roleModelEdge = graph.edges.find(e => e.from === "role:default" && e.to === "model:openai/gpt-4o:high");
		expect(roleModelEdge).toBeDefined();
		expect(roleModelEdge?.kind).toBe("solid");
		expect(roleModelEdge?.relation).toBe("role-model");

		// Model-provider edge
		const modelProviderEdge = graph.edges.find(
			e => e.from === "model:openai/gpt-4o:high" && e.to === "provider:openai",
		);
		expect(modelProviderEdge).toBeDefined();
		expect(modelProviderEdge?.kind).toBe("solid");
		expect(modelProviderEdge?.relation).toBe("model-provider");

		// Agent-model edge
		const agentModelEdge = graph.edges.find(e => e.from === "agent:Reviewer" && e.to === "model:openai/gpt-4o:high");
		expect(agentModelEdge).toBeDefined();
		expect(agentModelEdge?.kind).toBe("solid");
		expect(agentModelEdge?.relation).toBe("agent-model");

		// Fallback edge
		const fallbackEdge = graph.edges.find(
			e => e.from === "model:openai/gpt-4o:high" && e.to === "model:anthropic/claude-3-5-sonnet",
		);
		expect(fallbackEdge).toBeDefined();
		expect(fallbackEdge?.kind).toBe("dashed");
		expect(fallbackEdge?.relation).toBe("fallback");
	});
});
