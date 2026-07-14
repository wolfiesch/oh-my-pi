import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeServerFrame, entryId, hostId, parseBounded, projectId, sessionId } from "@oh-my-pi/app-wire";
import { FileSessionDiscovery, SessionEntryProjector } from "../src/discovery.ts";
import { SessionProjection } from "../src/projection.ts";
import type { FileSystem } from "../src/types.ts";

const stamp = "2026-07-11T00:00:00.000Z";
const host = hostId("discovery-test");

function fakeFs(files: Record<string, string>, directories: string[]): FileSystem {
	return {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		stat: async path => ({
			isFile: () => path in files,
			isDirectory: () => directories.includes(path),
			mode: 0o600,
			mtimeMs: 1,
			size: files[path]?.length ?? 0,
		}),
		readdir: async path =>
			[...Object.keys(files), ...directories].filter(
				child => child !== path && child.startsWith(`${path}/`) && !child.slice(path.length + 1).includes("/"),
			),
		readFile: async path => files[path] ?? "",
	};
}

function line(value: Record<string, unknown>): string {
	return JSON.stringify(value);
}
function transcript(entries: Record<string, unknown>[], title?: string): string {
	const prelude = title === undefined ? [] : [{ type: "title", v: 1, title, updatedAt: stamp, pad: "" }];
	return [
		...prelude,
		{ type: "session", version: 3, id: "session-1", cwd: "/home/tester/project", timestamp: stamp },
		...entries,
	]
		.map(line)
		.join("\n");
}

function sessionTranscript(id: string, cwd: string, title: string): string {
	return JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: stamp, title });
}

describe("current OMP JSONL projection", () => {
	test("projects ordered transcript image metadata without image bytes or paths", () => {
		const first = "a".repeat(64);
		const second = "b".repeat(64);
		const projector = new SessionEntryProjector(host, sessionId("session-images"), "live");
		const projected = projector.project({
			type: "message",
			id: "image-message",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{ type: "image", mimeType: "image/png", data: `blob:sha256:${first}` },
					{ type: "text", text: "two images" },
					{ type: "image", mimeType: "image/webp", data: "", appImageSha256: second },
				],
			},
		});
		expect(projected).toHaveLength(1);
		expect(projected[0]?.data).toEqual({
			role: "assistant",
			text: "two images",
			images: [
				{ sha256: first, mimeType: "image/png" },
				{ sha256: second, mimeType: "image/webp" },
			],
		});
		const serialized = JSON.stringify(projected[0]);
		expect(serialized).not.toContain("blob:sha256:");
		expect(serialized).not.toContain("appImageSha256");
		expect(serialized).not.toContain("/home/");
		const [batchEntry] = new SessionEntryProjector(host, sessionId("batch-images"), "batch").project({
			type: "message",
			id: "spoofed-marker",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "untrusted persisted marker" },
					{ type: "image", mimeType: "image/webp", data: "", appImageSha256: second },
				],
			},
		});
		expect(batchEntry?.data).toEqual({ role: "assistant", text: "untrusted persisted marker" });

		const record = {
			sessionId: sessionId("session-images"),
			path: "/session.jsonl",
			cwd: "/project",
			projectId: projectId("project-images"),
			title: "Images",
			updatedAt: stamp,
			status: "idle" as const,
			entries: projected,
		};
		const projection = new SessionProjection(host, record, "epoch");
		expect(projection.transcriptImage(entryId("image-message"), first)).toEqual({
			sha256: first,
			mimeType: "image/png",
		});
		expect(projection.transcriptImage(entryId("image-message"), "c".repeat(64))).toBeUndefined();
		expect(projection.transcriptImage(entryId("other-entry"), first)).toBeUndefined();
	});

	test("normalizes nested messages, tools, hidden entries, and runtime settings", async () => {
		const hugeArgs = Array.from({ length: 1000 }, () => "x".repeat(900));
		const toolImage = "d".repeat(64);
		const entries: Record<string, unknown>[] = [
			{
				type: "session_init",
				id: "init",
				parentId: null,
				timestamp: stamp,
				systemPrompt: "do not leak /home/tester/secret",
				task: "task",
				tools: ["read"],
			},
			{ type: "model_change", id: "model", parentId: "init", timestamp: stamp, model: "openai/gpt-5.6" },
			{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: stamp, thinkingLevel: "high" },
			{
				type: "message",
				id: "u1",
				parentId: "thinking",
				timestamp: stamp,
				message: { role: "user", content: "Please inspect the project" },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: stamp,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should inspect safely." },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "/home/tester/project/src/app.ts", values: hugeArgs },
						},
					],
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: stamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [
						{ type: "text", text: "file contents" },
						{ type: "image", mimeType: "image/jpeg", data: `blob:sha256:${toolImage}` },
					],
					isError: false,
				},
			},
			{
				type: "custom_message",
				id: "hidden",
				parentId: "r1",
				timestamp: stamp,
				customType: "secret",
				content: "hidden",
				display: false,
			},
			{
				type: "custom_message",
				id: "shown",
				parentId: "hidden",
				timestamp: stamp,
				customType: "notice",
				content: "Visible note",
				display: true,
				attribution: "agent",
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries, "  Fixed\nTitle  ") }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("Fixed Title");
		expect(session?.projectName).toBe("project");
		expect(session?.cwd).toBe("/home/tester/project");
		expect(session?.model).toBe("openai/gpt-5.6");
		expect(session?.thinking).toBe("high");
		expect(session?.entries.map(entry => entry.kind)).toEqual(["message", "message", "tool-use", "message"]);
		const message = session?.entries[0];
		expect(message?.data).toEqual({ role: "user", text: "Please inspect the project" });
		const tool = session?.entries[2];
		expect(tool?.data).toMatchObject({
			tool: "read",
			title: "read",
			ok: true,
			result: { output: "file contents" },
			images: [{ sha256: toolImage, mimeType: "image/jpeg" }],
		});
		const toolArgs = tool?.data.args && typeof tool.data.args === "object" ? JSON.stringify(tool.data.args) : "";
		expect(new TextEncoder().encode(toolArgs).byteLength).toBeLessThan(128 * 1024);
		expect(JSON.stringify(session?.entries)).not.toContain("systemPrompt");
		expect(JSON.stringify(session?.entries)).not.toContain("/home/tester");
		expect(session?.entries[1]?.data).toEqual({ role: "assistant", text: "", reasoning: "I should inspect safely." });
	});

	test("rebinds discovered entry identities to the snapshot envelope", async () => {
		const entries = [
			{
				type: "message",
				id: "mismatch",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "hello" },
			},
		];
		const sessionDiscovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			hostId("discovery-other"),
		);
		const [session] = await sessionDiscovery.list();
		if (!session) throw new Error("session not discovered");
		const frame = new SessionProjection(host, session, "epoch-test").snapshot();
		const decoded = decodeServerFrame(frame);
		expect(decoded.type).toBe("snapshot");
		if (decoded.type === "snapshot") {
			expect(
				decoded.entries.every(entry => entry.hostId === decoded.hostId && entry.sessionId === decoded.sessionId),
			).toBe(true);
		}
	});

	test("bounds non-ASCII titles and falls back to the first visible user text", async () => {
		const title = `${"界".repeat(400)}\n  `;
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "First visible request" },
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("First visible request");
		const titledDiscovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript([], title) }, ["/root"]),
			host,
		);
		const [titled] = await titledDiscovery.list();
		expect(titled?.title).toBeDefined();
		expect(new TextEncoder().encode(titled?.title ?? "").byteLength).toBeLessThanOrEqual(512);
	});

	test("uses the first substantive Change line for a bounded fallback title", async () => {
		const wrapped = `Complete the assignment below, thoroughly:\n\n# Target\nIgnore this heading\n\n# Change\n1. Build a durable projector with a deliberately long description ${"x".repeat(200)}`;
		const entries = [
			{ type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: wrapped } },
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title?.startsWith("Build a durable projector")).toBe(true);
		expect(new TextEncoder().encode(session?.title ?? "").byteLength).toBeLessThanOrEqual(120);
	});

	test("skips a wrapper line when Change is absent", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: {
					role: "user",
					content: "Complete the assignment below, thoroughly:\n\n# Target\nFallback title",
				},
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("Fallback title");
	});

	test("keeps direct-message fallback on its first substantive line", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "Please inspect this project\n# Change\n1. Do not use this as a title" },
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("Please inspect this project");
	});

	test("keeps valid session history around a malformed middle entry", async () => {
		const header = sessionTranscript("session-malformed-middle", "/tmp/project", "Recovered session");
		const before = line({
			type: "message",
			id: "before",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "before malformed entry" },
		});
		const after = line({
			type: "message",
			id: "after",
			parentId: "before",
			timestamp: stamp,
			message: { role: "assistant", content: "after malformed entry" },
		});
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": [header, before, '{"type":', after].join("\n") }, ["/root"]),
			host,
		);

		const [session] = await discovery.list();
		expect(String(session?.sessionId)).toBe("session-malformed-middle");
		expect(session?.entries.map(entry => entry.data.text)).toEqual([
			"before malformed entry",
			"after malformed entry",
		]);
	});

	test("keeps valid session history when the final JSONL write is crash-truncated", async () => {
		const header = sessionTranscript("session-truncated-tail", "/tmp/project", "Recovered tail");
		const complete = line({
			type: "message",
			id: "complete",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "complete entry" },
		});
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": `${header}\n${complete}\n{"type":"message","id":"partial"` }, ["/root"]),
			host,
		);

		const [session] = await discovery.list();
		expect(String(session?.sessionId)).toBe("session-truncated-tail");
		expect(session?.entries.map(entry => entry.data.text)).toEqual(["complete entry"]);
	});

	test("still rejects malformed or missing headers and oversized entry lines", async () => {
		const validHeader = sessionTranscript("oversized-entry", "/tmp/project", "Oversized entry");
		const files = {
			"/root/malformed-header.jsonl": '{"type":"session"',
			"/root/missing-header.jsonl": line({
				type: "message",
				id: "message-only",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "no header" },
			}),
			"/root/oversized-entry.jsonl": `${validHeader}\n${"x".repeat(1024 * 1024 + 1)}`,
		};
		const discovery = new FileSessionDiscovery("/root", fakeFs(files, ["/root"]), host);

		expect(await discovery.list()).toEqual([]);
	});

	test("limits snapshots to 1000 entries with an omission notice", async () => {
		const entries: Record<string, unknown>[] = [];
		for (let i = 0; i < 1001; i++)
			entries.push({
				type: "message",
				id: `m-${i}`,
				parentId: i === 0 ? null : `m-${i - 1}`,
				timestamp: stamp,
				message: { role: "user", content: `${"x".repeat(8192)} ${i}` },
			});
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.entries.length).toBeLessThanOrEqual(1000);
		expect(session?.entries[0]?.kind).toBe("compaction");
		expect(session?.entries[0]?.data.summary).toContain("Older transcript entries were omitted");
		expect(new Set(session?.entries.map(entry => entry.id)).size).toBe(session?.entries.length);
		expect(
			session?.entries.every(
				entry => entry.parentId === null || session?.entries.some(parent => parent.id === entry.parentId),
			),
		).toBe(true);
		if (!session) throw new Error("session not discovered");
		const initialOmitted = Number(session.entries[0]?.data.omitted);
		const projection = new SessionProjection(host, session, "epoch-test");
		for (let i = 0; i < 100; i++)
			projection.appendEntry({
				id: entryId(`live-after-discovery-${i}`),
				parentId: null,
				hostId: host,
				sessionId: session.sessionId,
				kind: "message",
				timestamp: stamp,
				data: { role: "assistant", text: `${"y".repeat(8192)} ${i}` },
			});
		const snapshot = projection.snapshot();
		const snapshotText = JSON.stringify(snapshot);
		expect(new TextEncoder().encode(snapshotText).byteLength).toBeLessThan(1_048_576);
		expect(() => parseBounded(snapshotText)).not.toThrow();
		if (snapshot.type !== "snapshot") throw new Error("expected snapshot");
		const notices = snapshot.entries.filter(entry => entry.data.snapshotOmission === true);
		expect(notices).toHaveLength(1);
		const projectedEntries = projection.value.entries.filter(entry => entry.data.snapshotOmission !== true).length;
		const retainedEntries = snapshot.entries.filter(entry => entry.data.snapshotOmission !== true).length;
		expect(Number(notices[0]?.data.omitted)).toBe(initialOmitted + projectedEntries - retainedEntries);
	});
});

test("lists only root and encoded-project main sessions, not child-area subagents", async () => {
	const files = {
		"/root/root-main.jsonl": sessionTranscript("root-main", "/tmp/root", "Root main"),
		"/root/root-main/root-subagent.jsonl": sessionTranscript("root-subagent", "/tmp/root", "Root subagent"),
		"/root/-tmp-project/project-main.jsonl": sessionTranscript("project-main", "/tmp/project", "Project main"),
		"/root/-tmp-project/project-main/project-subagent.jsonl": sessionTranscript(
			"project-subagent",
			"/tmp/project",
			"Project subagent",
		),
		"/root/-tmp-project/project-main/task/nested-task.jsonl": sessionTranscript(
			"nested-task",
			"/tmp/project",
			"Nested task",
		),
	};
	const directories = [
		"/root",
		"/root/root-main",
		"/root/-tmp-project",
		"/root/-tmp-project/project-main",
		"/root/-tmp-project/project-main/task",
	];
	const discovery = new FileSessionDiscovery("/root", fakeFs(files, directories), host);
	const sessions = await discovery.list();
	expect(sessions.map(session => String(session.sessionId)).sort()).toEqual(["project-main", "root-main"]);
});

test("lists oversized main metadata with a bounded prefix read", async () => {
	const path = "/root/oversized.jsonl";
	const header = `${sessionTranscript("oversized", "/tmp/oversized", "Oversized main")}\n`;
	let fullReads = 0;
	let prefixReads = 0;
	const fs: FileSystem & {
		readFileSlice(path: string, maxBytes: number): Promise<string>;
	} = {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		readdir: async directory => (directory === "/root" ? [path] : []),
		stat: async value => ({
			isFile: () => value === path,
			isDirectory: () => value === "/root",
			mode: 0o600,
			mtimeMs: 2,
			size: value === path ? 70 * 1024 * 1024 : 0,
		}),
		readFile: async () => {
			fullReads++;
			throw new Error("unbounded read");
		},
		readFileSlice: async (_value, maxBytes) => {
			prefixReads++;
			expect(maxBytes).toBeLessThanOrEqual(128 * 1024);
			return header;
		},
	};
	const discovery = new FileSessionDiscovery("/root", fs, host);
	const [session] = await discovery.list();
	expect(String(session?.sessionId)).toBe("oversized");
	expect(session?.title).toBe("Oversized main");
	expect(session?.entries).toEqual([]);
	expect(prefixReads).toBe(1);
	expect(fullReads).toBe(0);
});

test("incrementally indexes a large corpus and evicts only deleted or changed files", async () => {
	const files: Record<string, string> = {};
	const mtimes = new Map<string, number>();
	for (let index = 0; index < 5000; index++) {
		const path = `/root/session-${index}.jsonl`;
		files[path] = JSON.stringify({
			type: "session",
			version: 3,
			id: `session-${index}`,
			cwd: "/tmp/project",
			timestamp: stamp,
		});
		mtimes.set(path, index);
	}
	let reads = 0;
	const fs: FileSystem = {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		stat: async path => ({
			isFile: () => path in files,
			isDirectory: () => path === "/root",
			mode: 0o600,
			mtimeMs: mtimes.get(path) ?? 0,
			size: files[path]?.length ?? 0,
		}),
		readdir: async path => (path === "/root" ? Object.keys(files) : []),
		readFile: async path => {
			reads++;
			return files[path] ?? "";
		},
	};
	const discovery = new FileSessionDiscovery("/root", fs, host);
	const cold = await discovery.list();
	expect(cold).toHaveLength(5000);
	expect(reads).toBe(5000);
	expect(cold.slice(0, 3).map(value => String(value.sessionId))).toEqual([
		"session-4999",
		"session-4998",
		"session-4997",
	]);
	reads = 0;
	const warm = await discovery.list();
	expect(warm).toHaveLength(5000);
	expect(reads).toBe(0);
	const changedPath = "/root/session-2500.jsonl";
	files[changedPath] = JSON.stringify({
		type: "session",
		version: 3,
		id: "session-2500",
		cwd: "/tmp/changed",
		timestamp: stamp,
	});
	mtimes.set(changedPath, 10_000);
	const changed = await discovery.list();
	expect(reads).toBe(1);
	expect(changed.find(value => String(value.sessionId) === "session-2500")?.cwd).toBe("/tmp/changed");
	delete files["/root/session-10.jsonl"];
	mtimes.delete("/root/session-10.jsonl");
	reads = 0;
	const deleted = await discovery.list();
	expect(deleted).toHaveLength(4999);
	expect(deleted.some(value => String(value.sessionId) === "session-10")).toBe(false);
	expect(reads).toBe(0);
});

test("rebinds a canonical cached transcript when its live symlink alias changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-discovery-alias-"));
	const target = join(root, "session-target.jsonl");
	const firstAlias = join(root, "alias-a.jsonl");
	const secondAlias = join(root, "alias-b.jsonl");
	const contents = JSON.stringify({
		type: "session",
		version: 3,
		id: "alias-session",
		cwd: "/tmp/project",
		timestamp: stamp,
	});
	try {
		await writeFile(target, contents);
		await symlink(target, firstAlias);
		const discovery = new FileSessionDiscovery(root, undefined, host);
		const first = await discovery.list();
		expect(first[0]?.path).toBe(firstAlias);
		await rm(firstAlias);
		await symlink(target, secondAlias);
		const warmAlias = await discovery.list();
		expect(warmAlias[0]?.path).toBe(secondAlias);
		await expect(stat(warmAlias[0]!.path)).resolves.toBeDefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
