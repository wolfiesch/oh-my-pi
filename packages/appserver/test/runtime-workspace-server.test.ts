import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, type ServerFrame } from "@oh-my-pi/app-wire";
import { RuntimeAdapterRegistry, type RuntimeAdapter } from "../src/runtime-adapter.ts";
import { appserverSupportedFeatures, createAppserver } from "../src/server.ts";
import { WorkspaceAuthority } from "../src/workspace-authority.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("runtime-workspace-test-host");

async function git(cwd: string, ...arguments_: string[]): Promise<void> {
	const child = Bun.spawn(["git", "-C", cwd, ...arguments_], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
}

function hello(): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "authority-test", version: "1", build: "test", platform: "linux" },
		requestedFeatures: ["runtime.adapters", "workspace.lifecycle"],
		capabilities: { client: ["sessions.read", "sessions.manage"] },
		savedCursors: [],
	};
}

function command(requestId: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId,
		commandId: requestId,
		hostId: host,
		command: name,
		args,
	};
}

async function response(
	client: RawUdsWebSocket,
	requestId: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "response" && frame.requestId === requestId) return frame;
	}
}

test("negotiates and serves runtime and workspace authority commands", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-authority-wire-")));
	const workspaceAuthority = await WorkspaceAuthority.open({ databasePath: join(root, "workspaces.sqlite") });
	const repository = join(root, "repository");
	await mkdir(repository);
	await git(repository, "init", "-q");
	await git(repository, "config", "user.email", "test@example.invalid");
	await git(repository, "config", "user.name", "Runtime Workspace Test");
	await writeFile(join(repository, "README.md"), "fixture\n");
	await git(repository, "add", "README.md");
	await git(repository, "commit", "-qm", "fixture");
	await workspaceAuthority.import({
		repositoryId: "project-wire",
		repositoryPath: repository,
		workspacePath: repository,
		ownership: "repository-root",
	});
	const runtimes = new RuntimeAdapterRegistry({
		executableAvailable: executable => {
			if (executable === "broken-runtime") throw new Error("probe failed");
			return true;
		},
	});
	const adapter: RuntimeAdapter = {
		manifest: {
			id: "test-runtime",
			displayName: "Test Runtime",
			command: { executable: "test-runtime", arguments: [] },
			capabilities: { prompt: "native" },
		},
		openSession: async () => {
			throw new Error("not used by discovery commands");
		},
	};
	runtimes.register(adapter);
	runtimes.register({
		...adapter,
		manifest: { ...adapter.manifest, id: "broken-runtime", command: { executable: "broken-runtime", arguments: [] } },
	});
	expect(appserverSupportedFeatures({ workspaceAuthority })).not.toContain("workspace.lifecycle");
	const appserver = createAppserver({
		hostId: host,
		epoch: "authority-wire-test",
		socketPath: join(root, "run", "app.sock"),
		runtimeAdapters: runtimes,
		workspaceAuthority,
		projectRootForProject: () => repository,
		workspaceTargetPathForProject: (_projectId, name) => join(root, name),
	});
	let client: RawUdsWebSocket | undefined;
	try {
		await appserver.start();
		client = await RawUdsWebSocket.connect(appserver.socketPath);
		client.sendJson(hello());
		const welcome = await client.nextServer();
		expect(welcome).toMatchObject({
			type: "welcome",
			grantedFeatures: expect.arrayContaining(["runtime.adapters", "workspace.lifecycle"]),
		});
		expect((await client.nextServer()).type).toBe("sessions");

		client.sendJson(command("runtime-list", "runtime.list"));
		expect(await response(client, "runtime-list")).toMatchObject({
			ok: true,
			result: {
				runtimes: [
					{
						id: "test-runtime",
						availability: { state: "available" },
					},
					{
						id: "broken-runtime",
						availability: { state: "unknown" },
					},
				],
			},
		});

		client.sendJson(command("workspace-list", "workspace.list"));
		const workspaceList = await response(client, "workspace-list");
		expect(workspaceList).toMatchObject({
			ok: true,
			result: { workspaces: [{ repositoryId: "project-wire", ownership: "repository-root" }] },
		});
		const projectedWorkspace = (workspaceList.result as { workspaces: Array<Record<string, unknown>> })
			.workspaces[0]!;
		expect(projectedWorkspace).not.toHaveProperty("repositoryRoot");
		expect(projectedWorkspace).not.toHaveProperty("canonicalPath");
		expect(projectedWorkspace).not.toHaveProperty("recoveryDiagnostic");

		client.sendJson(command("workspace-recover", "workspace.recover"));
		expect(await response(client, "workspace-recover")).toMatchObject({ ok: true, result: { workspaces: [] } });
	} finally {
		client?.destroy();
		if (client) await client.closed();
		await appserver.stop();
		workspaceAuthority.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("runs owner initialization only after exclusive appserver ownership", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-owner-initialization-")));
	const socketPath = join(root, "run", "app.sock");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let competingHookRan = false;
	const owner = createAppserver({
		hostId: host,
		epoch: "owner-initialization-test",
		socketPath,
		onOwnerAcquired: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	const competing = createAppserver({
		hostId: host,
		epoch: "competing-owner-test",
		socketPath,
		onOwnerAcquired: () => {
			competingHookRan = true;
		},
	});
	try {
		const ownerStart = owner.start();
		await entered.promise;
		await expect(competing.start()).rejects.toThrow("another owner");
		expect(competingHookRan).toBeFalse();
		release.resolve();
		await ownerStart;
	} finally {
		release.resolve();
		await competing.stop();
		await owner.stop();
		await rm(root, { recursive: true, force: true });
	}
});
