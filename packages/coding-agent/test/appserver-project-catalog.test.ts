import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectId } from "@oh-my-pi/app-wire";
import { stableProjectId } from "@oh-my-pi/appserver";
import { createAppserverRuntime } from "../src/session/appserver-authority";
import { defaultSameFamilyProjectCatalog, SameFamilyProjectCatalog } from "../src/session/appserver-project-catalog";

const timestamp = "2026-01-01T00:00:00.000Z";

async function tempRoot(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-project-catalog-"));
}

async function writeTranscript(sessionsDir: string, name: string, cwd: string): Promise<void> {
	await fs.mkdir(sessionsDir, { recursive: true });
	await Bun.write(
		path.join(sessionsDir, `${name}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: name, timestamp, cwd })}\n`,
	);
}

describe("same-family appserver project catalog", () => {
	test("disables cross-profile fallback for custom config families", () => {
		const previous = process.env.PI_CONFIG_DIR;
		try {
			process.env.PI_CONFIG_DIR = ".omp-work-isolated";
			expect(defaultSameFamilyProjectCatalog()).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
		}
	});

	test("bootstraps the first session in an empty named profile from default-profile metadata", async () => {
		const root = await tempRoot();
		try {
			const family = path.join(root, ".omp");
			const project = path.join(root, "project");
			const activeSessions = path.join(family, "profiles", "fable", "agent", "sessions");
			await fs.mkdir(project, { recursive: true });
			await fs.mkdir(activeSessions, { recursive: true });
			await writeTranscript(path.join(family, "agent", "sessions"), "default-session", project);

			const runtime = createAppserverRuntime({
				sessionsDir: activeSessions,
				lifecycleMetadataPath: path.join(root, "lifecycle.json"),
				projectCatalog: new SameFamilyProjectCatalog(family),
			});
			expect(await runtime.discovery.list()).toEqual([]);
			expect(await runtime.projectRootForProject(stableProjectId(project))).toBe(await fs.realpath(project));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("includes native personal profiles but excludes sibling config families and profile symlinks", async () => {
		const root = await tempRoot();
		try {
			const family = path.join(root, ".omp");
			const personalProject = path.join(root, "personal-project");
			const workProject = path.join(root, "work-project");
			const workProfile = path.join(root, "omp-work", "agent", "sessions");
			await Promise.all([
				fs.mkdir(personalProject, { recursive: true }),
				fs.mkdir(workProject, { recursive: true }),
			]);
			await writeTranscript(
				path.join(family, "profiles", "personal", "agent", "sessions"),
				"personal-session",
				personalProject,
			);
			await writeTranscript(workProfile, "work-session", workProject);
			await fs.mkdir(path.join(family, "profiles"), { recursive: true });
			await fs.symlink(path.join(root, "omp-work"), path.join(family, "profiles", "linked-work"), "dir");

			const catalog = new SameFamilyProjectCatalog(family);
			expect(await catalog.resolve(stableProjectId(personalProject))).toBe(await fs.realpath(personalProject));
			await expect(catalog.resolve(stableProjectId(workProject))).rejects.toThrow("unknown project");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("honors transcript and profile scan bounds", async () => {
		const root = await tempRoot();
		try {
			const family = path.join(root, ".omp");
			const defaultProject = path.join(root, "default-project");
			const namedProject = path.join(root, "named-project");
			await Promise.all([
				fs.mkdir(defaultProject, { recursive: true }),
				fs.mkdir(namedProject, { recursive: true }),
			]);
			await writeTranscript(path.join(family, "agent", "sessions"), "default-session", defaultProject);
			await writeTranscript(
				path.join(family, "profiles", "alpha", "agent", "sessions"),
				"alpha-session",
				namedProject,
			);

			const transcriptBound = new SameFamilyProjectCatalog(family, { maxTranscripts: 1 });
			expect(await transcriptBound.resolve(stableProjectId(defaultProject))).toBe(await fs.realpath(defaultProject));
			await expect(transcriptBound.resolve(stableProjectId(namedProject))).rejects.toThrow("unknown project");

			const profileBound = new SameFamilyProjectCatalog(family, { maxProfiles: 0 });
			expect(await profileBound.resolve(stableProjectId(defaultProject))).toBe(await fs.realpath(defaultProject));
			await expect(profileBound.resolve(stableProjectId(namedProject))).rejects.toThrow("unknown project");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("refreshes its bounded snapshot when a newly indexed project misses the cache", async () => {
		const root = await tempRoot();
		try {
			const family = path.join(root, ".omp");
			const sessions = path.join(family, "agent", "sessions");
			const firstProject = path.join(root, "first-project");
			const laterProject = path.join(root, "later-project");
			await Promise.all([fs.mkdir(firstProject, { recursive: true }), fs.mkdir(laterProject, { recursive: true })]);
			await writeTranscript(sessions, "first-session", firstProject);
			const catalog = new SameFamilyProjectCatalog(family);
			expect(await catalog.resolve(stableProjectId(firstProject))).toBe(await fs.realpath(firstProject));

			await writeTranscript(sessions, "later-session", laterProject);
			expect(await catalog.resolve(stableProjectId(laterProject))).toBe(await fs.realpath(laterProject));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("revalidates canonical directories when a symlink target changes after indexing", async () => {
		const root = await tempRoot();
		try {
			const family = path.join(root, ".omp");
			const firstProject = path.join(root, "first-project");
			const secondProject = path.join(root, "second-project");
			const linkedProject = path.join(root, "linked-project");
			await Promise.all([fs.mkdir(firstProject, { recursive: true }), fs.mkdir(secondProject, { recursive: true })]);
			await fs.symlink(firstProject, linkedProject, "dir");
			await writeTranscript(path.join(family, "agent", "sessions"), "linked-session", linkedProject);

			const catalog = new SameFamilyProjectCatalog(family);
			const firstId = stableProjectId(firstProject);
			expect(await catalog.resolve(firstId)).toBe(await fs.realpath(firstProject));

			await fs.unlink(linkedProject);
			await fs.rm(firstProject, { recursive: true });
			await fs.symlink(secondProject, linkedProject, "dir");
			await expect(catalog.resolve(firstId)).rejects.toThrow("unknown project");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed when distinct canonical roots map to the same project id", async () => {
		const root = await tempRoot();
		try {
			const family = path.join(root, ".omp");
			const firstProject = path.join(root, "first-project");
			const secondProject = path.join(root, "second-project");
			const collision = projectId("project-collision");
			await Promise.all([fs.mkdir(firstProject, { recursive: true }), fs.mkdir(secondProject, { recursive: true })]);
			await writeTranscript(path.join(family, "agent", "sessions"), "first-session", firstProject);
			await writeTranscript(path.join(family, "agent", "sessions"), "second-session", secondProject);

			const catalog = new SameFamilyProjectCatalog(family, { projectIdForRoot: () => collision });
			await expect(catalog.resolve(collision)).rejects.toThrow("ambiguous project");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
