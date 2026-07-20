import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decodeServerFrame, hostId, projectId, sessionId } from "@oh-my-pi/app-wire";
import { SessionProjection } from "@oh-my-pi/appserver";
import { createAppserverRuntime } from "../src/session/appserver-authority";
import { AppserverSessionLifecycleStore } from "../src/session/appserver-session-lifecycle";
import { acquireSessionLock } from "../src/session/session-lock";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; sessionsDir: string; metadataPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-appserver-lifecycle-"));
	roots.push(root);
	const sessionsDir = path.join(root, "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	return {
		root,
		sessionsDir,
		metadataPath: path.join(root, "profile", "appserver", "session-lifecycle.json"),
	};
}

async function writeSession(sessionsDir: string, id: string): Promise<string> {
	const transcript = path.join(sessionsDir, `${id}.jsonl`);
	await fs.writeFile(
		transcript,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-07-13T12:00:00.000Z",
			cwd: sessionsDir,
		})}\n`,
	);
	const artifacts = transcript.slice(0, -6);
	await fs.mkdir(artifacts);
	await fs.writeFile(path.join(artifacts, "artifact.txt"), "artifact");
	return transcript;
}

describe("appserver session lifecycle authority", () => {
	test("new-session authority projects raw manager metadata before attach snapshots", async () => {
		const { root, sessionsDir, metadataPath } = await fixture();
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd);
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const created = await runtime.sessionAuthority.create(cwd, "Fresh remote session");
		const transcript = (await fs.readFile(created.path, "utf8"))
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);

		expect(transcript.some(entry => entry.type === "title_change")).toBe(true);
		expect(transcript.some(entry => entry.type === "title_change" && entry.data === undefined)).toBe(true);
		expect(created.entries).toEqual([]);

		const projection = new SessionProjection(
			hostId("new-session-projection-test"),
			{
				...created,
				projectId: projectId("new-session-project"),
				projectName: "workspace",
				title: created.title ?? "Session",
				updatedAt: "2026-07-13T12:00:00.000Z",
				status: "idle",
			},
			"new-session-epoch",
		);
		const snapshot = projection.snapshot();
		expect(snapshot).toMatchObject({ type: "snapshot", entries: [] });
		expect(decodeServerFrame(snapshot)).toMatchObject({ type: "snapshot", entries: [] });
	});

	test("pages the newest OMP transcript entries through the T4 host reader", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-paged-tail");
		const entries = [
			{ id: "message-1", parentId: null, role: "user", content: "first" },
			{ id: "message-2", parentId: "message-1", role: "assistant", content: "second" },
			{ id: "message-3", parentId: "message-2", role: "assistant", content: "third" },
		];
		await fs.appendFile(
			transcript,
			`${entries
				.map((entry, index) =>
					JSON.stringify({
						type: "message",
						id: entry.id,
						parentId: entry.parentId,
						timestamp: `2026-07-13T12:00:0${index + 1}.000Z`,
						message: { role: entry.role, content: entry.content },
					}),
				)
				.join("\n")}\n`,
		);

		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		expect(record).toBeDefined();
		expect(runtime.discovery.page).toBeFunction();
		const newest = await runtime.discovery.page!(record!, { limit: 2, maxBytes: 4 * 1024 });
		expect(newest.entries.map(entry => entry.data.text)).toEqual(["second", "third"]);
		expect(newest.hasMore).toBe(true);
		expect(newest.nextCursor).toBeString();

		const earlier = await runtime.discovery.page!(record!, {
			before: newest.nextCursor!,
			limit: 2,
			maxBytes: 4 * 1024,
		});
		expect(earlier.entries.map(entry => entry.data.text)).toEqual(["first"]);
		expect(earlier.hasMore).toBe(false);
	});

	test("archive and restore survive runtime restart with private atomic metadata", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		await writeSession(sessionsDir, "session-durable");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		expect(record).toBeDefined();
		const archivedAt = "2026-07-13T12:34:56.000Z";
		await runtime.sessionAuthority.archive(record!, archivedAt);

		const restarted = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		expect(await restarted.discovery.list()).toEqual([
			expect.objectContaining({ sessionId: record!.sessionId, archivedAt }),
		]);
		expect((await fs.stat(metadataPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.dirname(metadataPath))).mode & 0o777).toBe(0o700);

		const [archived] = await restarted.discovery.list();
		await restarted.sessionAuthority.restore(archived!);
		const restored = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		expect((await restored.discovery.list())[0]?.archivedAt).toBeUndefined();
	});

	test("archive holds the real session lock across its metadata commit", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-archive-lock");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		const competing = acquireSessionLock(transcript);
		try {
			await expect(runtime.sessionAuthority.archive(record!, "2026-07-13T12:34:56.000Z")).rejects.toThrow();
			expect((await runtime.discovery.list())[0]?.archivedAt).toBeUndefined();
		} finally {
			competing.release();
		}
	});

	test("delete holds the real session lock and removes transcript plus artifacts through a tombstone", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-delete");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		expect(record?.path).toBe(transcript);
		const competing = acquireSessionLock(transcript);
		try {
			await expect(runtime.sessionAuthority.delete(record!)).rejects.toThrow();
			expect(await fs.readFile(transcript, "utf8")).toContain("session-delete");
			expect(await fs.readFile(path.join(transcript.slice(0, -6), "artifact.txt"), "utf8")).toBe("artifact");
		} finally {
			competing.release();
		}

		await runtime.sessionAuthority.delete(record!);
		await expect(fs.stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(transcript.slice(0, -6))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await runtime.discovery.list()).map(value => value.sessionId)).not.toContain(record!.sessionId);
		expect((await fs.readdir(sessionsDir)).some(name => name.startsWith(".omp-appserver-delete-"))).toBe(false);
	});

	test("restart rolls back an uncommitted same-filesystem tombstone", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const id = sessionId("session-recover");
		const transcript = await writeSession(sessionsDir, id);
		const artifacts = transcript.slice(0, -6);
		const tombstone = path.join(sessionsDir, ".omp-appserver-delete-interrupted");
		await fs.mkdir(tombstone, { mode: 0o700 });
		await fs.writeFile(
			path.join(tombstone, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				sessionId: id,
				transcriptName: path.basename(transcript),
				artifactsName: path.basename(artifacts),
			})}\n`,
			{ mode: 0o600 },
		);
		await fs.rename(artifacts, path.join(tombstone, path.basename(artifacts)));
		await fs.rename(transcript, path.join(tombstone, path.basename(transcript)));

		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await store.recoverDeletes();
		expect(await fs.readFile(transcript, "utf8")).toContain(id);
		expect(await fs.readFile(path.join(artifacts, "artifact.txt"), "utf8")).toBe("artifact");
		await expect(fs.stat(tombstone)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("restart finishes committed tombstones and clears present or already-absent pending metadata idempotently", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const committedId = sessionId("session-committed-delete");
		const absentId = sessionId("session-already-cleaned");
		const committedName = ".omp-appserver-delete-committed";
		const absentName = ".omp-appserver-delete-already-absent";
		const committed = path.join(sessionsDir, committedName);
		await fs.mkdir(committed, { mode: 0o700 });
		await fs.writeFile(
			path.join(committed, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				sessionId: committedId,
				transcriptName: `${committedId}.jsonl`,
				artifactsName: committedId,
			})}\n`,
			{ mode: 0o600 },
		);
		await fs.writeFile(path.join(committed, `${committedId}.jsonl`), "committed transcript");
		await fs.mkdir(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(
			metadataPath,
			`${JSON.stringify({
				version: 1,
				archived: [],
				pendingDeletes: [
					{ sessionId: committedId, tombstone: committedName },
					{ sessionId: absentId, tombstone: absentName },
				],
			})}\n`,
			{ mode: 0o600 },
		);

		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await store.recoverDeletes();
		await expect(fs.stat(committed)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(sessionsDir, `${committedId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
		const afterRecovery = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
			pendingDeletes: unknown[];
		};
		expect(afterRecovery.pendingDeletes).toEqual([]);

		await store.recoverDeletes();
		const afterRetry = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { pendingDeletes: unknown[] };
		expect(afterRetry.pendingDeletes).toEqual([]);
	});

	test("restart preserves a committed tombstone whose manifest names a different session", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const expectedId = sessionId("session-expected-delete");
		const otherId = sessionId("session-other-delete");
		const tombstoneName = ".omp-appserver-delete-mismatched";
		const tombstone = path.join(sessionsDir, tombstoneName);
		await fs.mkdir(tombstone, { mode: 0o700 });
		await fs.writeFile(
			path.join(tombstone, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				sessionId: otherId,
				transcriptName: `${otherId}.jsonl`,
				artifactsName: otherId,
			})}\n`,
			{ mode: 0o600 },
		);
		await fs.writeFile(path.join(tombstone, `${otherId}.jsonl`), "must survive");
		await fs.mkdir(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(
			metadataPath,
			`${JSON.stringify({
				version: 1,
				archived: [],
				pendingDeletes: [{ sessionId: expectedId, tombstone: tombstoneName }],
			})}\n`,
			{ mode: 0o600 },
		);

		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await store.recoverDeletes();
		expect(await fs.readFile(path.join(tombstone, `${otherId}.jsonl`), "utf8")).toBe("must survive");
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
			pendingDeletes: Array<{ sessionId: string; tombstone: string }>;
		};
		expect(metadata.pendingDeletes).toEqual([{ sessionId: expectedId, tombstone: tombstoneName }]);
	});

	test("rejects a transcript reached through a symlink that escapes the sessions root", async () => {
		const { root, sessionsDir, metadataPath } = await fixture();
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		const transcript = await writeSession(outside, "session-escape");
		const alias = path.join(sessionsDir, "-alias");
		await fs.symlink(outside, alias, "dir");
		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await expect(
			store.deleteSession(sessionId("session-escape"), path.join(alias, path.basename(transcript))),
		).rejects.toThrow(/symlink|outside/);
		expect(await fs.readFile(transcript, "utf8")).toContain("session-escape");
		expect(await fs.readFile(path.join(transcript.slice(0, -6), "artifact.txt"), "utf8")).toBe("artifact");
	});

	test("a lock release failure after deletion commit cannot reverse the reported outcome", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-release-failure");
		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir, {
			acquireLock: sessionPath => {
				const lock = acquireSessionLock(sessionPath);
				return {
					record: lock.record,
					lockPath: lock.lockPath,
					heartbeat: () => lock.heartbeat(),
					release: () => {
						lock.release();
						throw new Error("injected release failure");
					},
					get released() {
						return lock.released;
					},
				};
			},
		});
		await expect(store.deleteSession(sessionId("session-release-failure"), transcript)).resolves.toBeUndefined();
		await expect(fs.stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(transcript.slice(0, -6))).rejects.toMatchObject({ code: "ENOENT" });
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { pendingDeletes: unknown[] };
		expect(metadata.pendingDeletes).toEqual([]);
	});
});
