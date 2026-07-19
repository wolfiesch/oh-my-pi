import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import codingAgentPackage from "../packages/coding-agent/package.json" with { type: "json" };
import {
	CANONICAL_REPOSITORY_URL,
	type ReleaseMetadataInput,
	resolveCanonicalRepositoryUrl,
	resolveReleaseMetadata,
} from "./ci-release-metadata";

const metadataScript = path.join(import.meta.dir, "ci-release-metadata.ts");

async function git(cwd: string, args: string[]): Promise<void> {
	const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.text().trim();
}

async function runMetadataCli(cwd: string, canonicalRepositoryUrl: string, outputPath: string) {
	await fs.rm(outputPath, { force: true });
	const { GITHUB_ACTIONS: _githubActions, ...localEnvironment } = process.env;
	const proc = Bun.spawn(["bun", metadataScript], {
		cwd,
		env: {
			...localEnvironment,
			GITHUB_EVENT_NAME: "push",
			GITHUB_REF: "refs/heads/t4code/main",
			GITHUB_REF_NAME: "t4code/main",
			GITHUB_REPOSITORY: "lyc-aon/oh-my-pi",
			GITHUB_OUTPUT: outputPath,
			OMP_CI_CANONICAL_REPOSITORY_URL: canonicalRepositoryUrl,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const input = (overrides: Partial<ReleaseMetadataInput> = {}): ReleaseMetadataInput => ({
	eventName: "push",
	ref: "refs/heads/main",
	refName: "main",
	repository: "can1357/oh-my-pi",
	tagsAtHead: [],
	branchesContainingHead: [],
	availableOfficialTags: ["v16.5.2"],
	officialBaseProofs: [
		{
			tag: "v16.5.2",
			localObjectId: "official-tag-object",
			localCommitId: "official-commit",
			canonicalObjectId: "official-tag-object",
			canonicalCommitId: "official-commit",
			isAncestor: true,
		},
	],
	expectedVersion: "16.5.2",
	...overrides,
});

describe("release metadata", () => {
	it("pins canonical identity in GitHub Actions while allowing local test repositories", () => {
		const local = "/tmp/local-canonical.git";
		expect(resolveCanonicalRepositoryUrl({ OMP_CI_CANONICAL_REPOSITORY_URL: local })).toBe(local);
		expect(
			resolveCanonicalRepositoryUrl({
				GITHUB_ACTIONS: "true",
				OMP_CI_CANONICAL_REPOSITORY_URL: local,
			}),
		).toBe(CANONICAL_REPOSITORY_URL);
	});

	it("recognizes an exact upstream tag only on main", () => {
		expect(resolveReleaseMetadata(input({ tagsAtHead: ["v16.5.2"] }))).toEqual({
			isRelease: true,
			releaseTag: "v16.5.2",
			releaseKind: "upstream",
			releaseVersion: "16.5.2",
		});
		expect(
			resolveReleaseMetadata(
				input({ ref: "refs/heads/t4code/main", refName: "t4code/main", tagsAtHead: ["v16.5.2"] }),
			),
		).toMatchObject({ isRelease: false, releaseKind: "none" });
	});

	it("recognizes an exact integration tag only on t4code/main", () => {
		const tag = "t4code-16.5.2-appserver-1";
		expect(
			resolveReleaseMetadata(input({ ref: "refs/heads/t4code/main", refName: "t4code/main", tagsAtHead: [tag] })),
		).toEqual({
			isRelease: true,
			releaseTag: tag,
			releaseKind: "t4code",
			releaseVersion: "16.5.2",
		});
		expect(resolveReleaseMetadata(input({ tagsAtHead: [tag] }))).toMatchObject({
			isRelease: false,
			releaseKind: "none",
		});
	});

	it("allows a fork T4 release while suppressing upstream releases on fork refs", () => {
		const repository = "lyc-aon/oh-my-pi";
		expect(resolveReleaseMetadata(input({ repository, tagsAtHead: ["v16.5.2"] }))).toMatchObject({
			isRelease: false,
			releaseKind: "none",
		});
		expect(
			resolveReleaseMetadata(
				input({
					eventName: "workflow_dispatch",
					ref: "refs/tags/v16.5.2",
					refName: "v16.5.2",
					repository,
					tagsAtHead: ["v16.5.2"],
					branchesContainingHead: ["main"],
				}),
			),
		).toMatchObject({ isRelease: false, releaseKind: "none" });

		const t4Tag = "t4code-16.5.2-appserver-1";
		expect(
			resolveReleaseMetadata(
				input({ repository, ref: "refs/heads/t4code/main", refName: "t4code/main", tagsAtHead: [t4Tag] }),
			),
		).toMatchObject({ isRelease: true, releaseKind: "t4code" });
	});

	it("rejects lookalike tags and leading-zero semver components", () => {
		for (const tag of [
			"v16.5",
			"v16.5.2-rc.1",
			"v016.5.2",
			"t4code-16.5.2-appserver-0",
			"t4code-16.5.2-appserver-01",
			"t4code-v16.5.2-appserver-1",
			"t4code-16.5.2-appserver-1-extra",
		]) {
			const ref = tag.startsWith("t4code-") ? "refs/heads/t4code/main" : "refs/heads/main";
			expect(resolveReleaseMetadata(input({ ref, tagsAtHead: [tag] })).isRelease).toBe(false);
		}
	});

	it("never publishes from a pull request merge ref", () => {
		expect(
			resolveReleaseMetadata(
				input({
					eventName: "pull_request",
					ref: "refs/pull/42/merge",
					refName: "42/merge",
					tagsAtHead: ["v16.5.2", "t4code-16.5.2-appserver-1"],
				}),
			),
		).toMatchObject({ isRelease: false, releaseKind: "none" });
	});

	it("supports upstream and product tag-ref workflow dispatches on their owning branches", () => {
		expect(
			resolveReleaseMetadata(
				input({
					eventName: "workflow_dispatch",
					ref: "refs/tags/v16.5.2",
					refName: "v16.5.2",
					tagsAtHead: ["v16.5.2"],
					branchesContainingHead: ["main", "t4code/main"],
				}),
			),
		).toMatchObject({ isRelease: true, releaseKind: "upstream", releaseVersion: "16.5.2" });

		const t4Tag = "t4code-16.5.2-appserver-7";
		expect(
			resolveReleaseMetadata(
				input({
					eventName: "workflow_dispatch",
					ref: `refs/tags/${t4Tag}`,
					refName: t4Tag,
					tagsAtHead: [t4Tag],
					branchesContainingHead: ["t4code/main"],
				}),
			),
		).toMatchObject({ isRelease: true, releaseKind: "t4code", releaseVersion: "16.5.2" });
	});

	it("fails closed when a dispatched tag is not at HEAD or not in its owning branch", () => {
		expect(() =>
			resolveReleaseMetadata(
				input({
					eventName: "workflow_dispatch",
					ref: "refs/tags/v16.5.2",
					refName: "v16.5.2",
					tagsAtHead: [],
					branchesContainingHead: ["main"],
				}),
			),
		).toThrow("does not point at the checked-out commit");
		expect(() =>
			resolveReleaseMetadata(
				input({
					eventName: "workflow_dispatch",
					ref: "refs/tags/t4code-16.5.2-appserver-1",
					refName: "t4code-16.5.2-appserver-1",
					tagsAtHead: ["t4code-16.5.2-appserver-1"],
					branchesContainingHead: ["main"],
				}),
			),
		).toThrow("is not contained in t4code/main");
	});

	it("fails closed when HEAD carries multiple tags from one release family", () => {
		expect(() => resolveReleaseMetadata(input({ tagsAtHead: ["v16.5.2", "v16.5.3"] }))).toThrow(
			"multiple upstream release tags",
		);
	});

	it("fails closed when a release tag disagrees with the binary package version", () => {
		expect(() => resolveReleaseMetadata(input({ tagsAtHead: ["v16.5.3"], expectedVersion: "16.5.2" }))).toThrow(
			"declares 16.5.3, but pi-coding-agent is 16.5.2",
		);
	});

	it("fails closed when the exact official base tag is missing", () => {
		expect(() =>
			resolveReleaseMetadata(
				input({
					ref: "refs/heads/t4code/main",
					tagsAtHead: ["t4code-16.5.2-appserver-1"],
					availableOfficialTags: [],
					officialBaseProofs: [],
				}),
			),
		).toThrow("Required official base tag v16.5.2 is missing");
	});

	it("fails closed when only a different official version tag is available", () => {
		expect(() =>
			resolveReleaseMetadata(
				input({
					ref: "refs/heads/t4code/main",
					tagsAtHead: ["t4code-16.5.2-appserver-1"],
					availableOfficialTags: ["v16.5.1"],
					officialBaseProofs: [],
				}),
			),
		).toThrow("v16.5.2 does not match available official tag(s): v16.5.1");
	});

	it("fails closed when the exact official tag exists outside the T4 commit ancestry", () => {
		expect(() =>
			resolveReleaseMetadata(
				input({
					ref: "refs/heads/t4code/main",
					tagsAtHead: ["t4code-16.5.2-appserver-1"],
					officialBaseProofs: [
						{
							tag: "v16.5.2",
							localObjectId: "official-tag-object",
							localCommitId: "official-commit",
							canonicalObjectId: "official-tag-object",
							canonicalCommitId: "official-commit",
							isAncestor: false,
						},
					],
				}),
			),
		).toThrow("does not descend from official base tag v16.5.2");
	});

	it("fails closed when a counterfeit local tag points at an ancestor commit", () => {
		expect(() =>
			resolveReleaseMetadata(
				input({
					ref: "refs/heads/t4code/main",
					tagsAtHead: ["t4code-16.5.2-appserver-1"],
					officialBaseProofs: [
						{
							tag: "v16.5.2",
							localObjectId: "counterfeit-object",
							localCommitId: "counterfeit-commit",
							canonicalObjectId: "official-tag-object",
							canonicalCommitId: "official-commit",
							isAncestor: true,
						},
					],
				}),
			),
		).toThrow("Local official base tag v16.5.2 does not match can1357/oh-my-pi");
	});

	it("fails closed when the canonical repository lacks the required tag", () => {
		expect(() =>
			resolveReleaseMetadata(
				input({
					ref: "refs/heads/t4code/main",
					tagsAtHead: ["t4code-16.5.2-appserver-1"],
					officialBaseProofs: [
						{
							tag: "v16.5.2",
							localObjectId: "local-object",
							localCommitId: "local-commit",
							canonicalObjectId: null,
							canonicalCommitId: null,
							isAncestor: true,
						},
					],
				}),
			),
		).toThrow("Canonical repository is missing official base tag v16.5.2");
	});

	it("proves official identity and ancestry through the real CLI", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-metadata-"));
		const canonicalWork = path.join(root, "canonical-work");
		const canonicalBare = path.join(root, "canonical.git");
		const product = path.join(root, "product");
		const outputPath = path.join(root, "output");
		const releaseVersion = codingAgentPackage.version;
		const officialTag = `v${releaseVersion}`;
		const integrationTag = `t4code-${releaseVersion}-appserver-1`;
		const wrongOfficialTag = "v0.0.1";
		try {
			await fs.mkdir(canonicalWork);
			await git(canonicalWork, ["init", "-q"]);
			await git(canonicalWork, ["config", "user.name", "test"]);
			await git(canonicalWork, ["config", "user.email", "test@example.invalid"]);
			await git(canonicalWork, ["commit", "--allow-empty", "-qm", "official base"]);
			await git(canonicalWork, ["tag", "-am", "official release", officialTag]);
			await git(root, ["clone", "--bare", "-q", canonicalWork, canonicalBare]);
			await git(root, ["clone", "-q", canonicalBare, product]);
			const officialTagObject = await gitOutput(product, ["rev-parse", `refs/tags/${officialTag}`]);
			await git(product, ["config", "user.name", "test"]);
			await git(product, ["config", "user.email", "test@example.invalid"]);
			await git(product, ["commit", "--allow-empty", "-qm", "T4 product"]);
			await git(product, ["tag", integrationTag]);

			const valid = await runMetadataCli(product, canonicalBare, outputPath);
			expect(valid).toMatchObject({ exitCode: 0, stderr: "" });
			expect(await Bun.file(outputPath).text()).toContain("release-kind=t4code");

			await git(product, ["tag", "-d", officialTag]);
			const missing = await runMetadataCli(product, canonicalBare, outputPath);
			expect(missing.exitCode).not.toBe(0);
			expect(missing.stderr).toContain(`Required official base tag ${officialTag} is missing`);

			await git(product, ["tag", wrongOfficialTag, "HEAD~1"]);
			const wrong = await runMetadataCli(product, canonicalBare, outputPath);
			expect(wrong.exitCode).not.toBe(0);
			expect(wrong.stderr).toContain(`${officialTag} does not match available official tag(s): ${wrongOfficialTag}`);

			await git(product, ["tag", "-f", officialTag, "HEAD"]);
			const counterfeit = await runMetadataCli(product, canonicalBare, outputPath);
			expect(counterfeit.exitCode).not.toBe(0);
			expect(counterfeit.stderr).toContain(`Local official base tag ${officialTag} does not match can1357/oh-my-pi`);

			await git(product, ["update-ref", `refs/tags/${officialTag}`, officialTagObject]);
			await git(product, ["tag", "-d", integrationTag]);
			await git(product, ["switch", "--orphan", "disconnected"]);
			await git(product, ["commit", "--allow-empty", "-qm", "unrelated T4 product"]);
			await git(product, ["tag", integrationTag]);
			const nonAncestor = await runMetadataCli(product, canonicalBare, outputPath);
			expect(nonAncestor.exitCode).not.toBe(0);
			expect(nonAncestor.stderr).toContain(`does not descend from official base tag ${officialTag}`);

			await git(canonicalBare, ["tag", "-d", officialTag]);
			const canonicalMissing = await runMetadataCli(product, canonicalBare, outputPath);
			expect(canonicalMissing.exitCode).not.toBe(0);
			expect(canonicalMissing.stderr).toContain(`Canonical repository is missing official base tag ${officialTag}`);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
