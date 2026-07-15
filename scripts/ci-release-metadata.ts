#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { $ } from "bun";

export type ReleaseKind = "none" | "upstream" | "t4code";

export interface ReleaseMetadata {
	isRelease: boolean;
	releaseTag: string;
	releaseKind: ReleaseKind;
	releaseVersion: string;
}

export interface ReleaseMetadataInput {
	eventName: string;
	ref: string;
	refName: string;
	repository: string;
	tagsAtHead: string[];
	branchesContainingHead: string[];
	availableOfficialTags: string[];
	officialBaseProofs: OfficialBaseProof[];
	expectedVersion: string;
}

export interface OfficialBaseProof {
	tag: string;
	localObjectId: string | null;
	localCommitId: string | null;
	canonicalObjectId: string | null;
	canonicalCommitId: string | null;
	isAncestor: boolean;
}

interface ParsedReleaseTag {
	tag: string;
	kind: Exclude<ReleaseKind, "none">;
	version: string;
	requiredBranch: "main" | "t4code/main";
}

const SEMVER = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const UPSTREAM_TAG = new RegExp(`^v${SEMVER}$`);
const T4CODE_TAG = new RegExp(`^t4code-${SEMVER}-appserver-([1-9]\\d*)$`);
export const CANONICAL_REPOSITORY = "can1357/oh-my-pi";
export const CANONICAL_REPOSITORY_URL = `https://github.com/${CANONICAL_REPOSITORY}.git`;

export function resolveCanonicalRepositoryUrl(env: Record<string, string | undefined>): string {
	if (env.GITHUB_ACTIONS) return CANONICAL_REPOSITORY_URL;
	return env.OMP_CI_CANONICAL_REPOSITORY_URL ?? CANONICAL_REPOSITORY_URL;
}

function parseReleaseTag(tag: string): ParsedReleaseTag | null {
	const upstream = tag.match(UPSTREAM_TAG);
	if (upstream) {
		return { tag, kind: "upstream", version: `${upstream[1]}.${upstream[2]}.${upstream[3]}`, requiredBranch: "main" };
	}
	const t4code = tag.match(T4CODE_TAG);
	if (t4code) {
		return {
			tag,
			kind: "t4code",
			version: `${t4code[1]}.${t4code[2]}.${t4code[3]}`,
			requiredBranch: "t4code/main",
		};
	}
	return null;
}

const NO_RELEASE: ReleaseMetadata = {
	isRelease: false,
	releaseTag: "",
	releaseKind: "none",
	releaseVersion: "",
};

function metadataFor(candidate: ParsedReleaseTag, input: ReleaseMetadataInput): ReleaseMetadata {
	if (candidate.version !== input.expectedVersion) {
		throw new Error(
			`Release tag ${candidate.tag} declares ${candidate.version}, but pi-coding-agent is ${input.expectedVersion}`,
		);
	}
	if (candidate.kind === "t4code") {
		const officialTag = `v${candidate.version}`;
		const proof = input.officialBaseProofs.find(candidateProof => candidateProof.tag === officialTag);
		if (!proof?.localObjectId || !proof.localCommitId) {
			if (input.availableOfficialTags.length === 0) {
				throw new Error(`Required official base tag ${officialTag} is missing`);
			}
			throw new Error(
				`Required official base tag ${officialTag} does not match available official tag(s): ${input.availableOfficialTags.join(", ")}`,
			);
		}
		if (!proof.canonicalObjectId || !proof.canonicalCommitId) {
			throw new Error(`Canonical repository is missing official base tag ${officialTag}`);
		}
		if (proof.localObjectId !== proof.canonicalObjectId || proof.localCommitId !== proof.canonicalCommitId) {
			throw new Error(`Local official base tag ${officialTag} does not match can1357/oh-my-pi`);
		}
		if (!proof.isAncestor) {
			throw new Error(`T4 release commit does not descend from official base tag ${officialTag}`);
		}
	}
	return {
		isRelease: true,
		releaseTag: candidate.tag,
		releaseKind: candidate.kind,
		releaseVersion: candidate.version,
	};
}

function singleCandidate(tags: string[], kind: Exclude<ReleaseKind, "none">): ParsedReleaseTag | null {
	const matches = tags.map(parseReleaseTag).filter(candidate => candidate?.kind === kind);
	if (matches.length > 1) {
		throw new Error(
			`HEAD carries multiple ${kind} release tags: ${matches.map(candidate => candidate.tag).join(", ")}`,
		);
	}
	return matches[0] ?? null;
}

/**
 * Resolve the one release identity accepted by CI.
 *
 * Branch pushes only publish the tag family owned by that branch. A tag-ref
 * workflow dispatch must point at the checked-out commit and that commit must
 * be in the corresponding remote branch history, so a similarly named tag on
 * an unrelated commit cannot publish. T4 candidates additionally prove that
 * their exact official base tag object and peeled commit match the canonical
 * repository and that the base commit is in the T4 commit ancestry.
 */
export function resolveReleaseMetadata(input: ReleaseMetadataInput): ReleaseMetadata {
	if (input.eventName === "pull_request") return NO_RELEASE;

	if (input.ref === "refs/heads/main") {
		if (input.repository !== CANONICAL_REPOSITORY) return NO_RELEASE;
		const candidate = singleCandidate(input.tagsAtHead, "upstream");
		return candidate ? metadataFor(candidate, input) : NO_RELEASE;
	}
	if (input.ref === "refs/heads/t4code/main") {
		const candidate = singleCandidate(input.tagsAtHead, "t4code");
		return candidate ? metadataFor(candidate, input) : NO_RELEASE;
	}

	if (input.eventName !== "workflow_dispatch" || !input.ref.startsWith("refs/tags/")) {
		return NO_RELEASE;
	}

	const tag = input.refName || input.ref.slice("refs/tags/".length);
	const candidate = parseReleaseTag(tag);
	if (!candidate) return NO_RELEASE;
	if (candidate.kind === "upstream" && input.repository !== CANONICAL_REPOSITORY) return NO_RELEASE;
	if (!input.tagsAtHead.includes(tag)) {
		throw new Error(`Dispatched tag ${tag} does not point at the checked-out commit`);
	}
	if (!input.branchesContainingHead.includes(candidate.requiredBranch)) {
		throw new Error(`Dispatched ${candidate.kind} tag ${tag} is not contained in ${candidate.requiredBranch}`);
	}
	return metadataFor(candidate, input);
}

async function tagsAtHead(): Promise<string[]> {
	const result = await $`git tag --points-at HEAD`.quiet();
	return result
		.text()
		.split("\n")
		.map(tag => tag.trim())
		.filter(Boolean);
}

async function officialTags(args: string[]): Promise<string[]> {
	const result = await $`git tag ${args}`.quiet();
	return result
		.text()
		.split("\n")
		.map(tag => tag.trim())
		.filter(tag => parseReleaseTag(tag)?.kind === "upstream");
}

async function revParse(ref: string): Promise<string | null> {
	const result = await $`git rev-parse --verify --quiet ${ref}`.quiet().nothrow();
	if (result.exitCode !== 0) return null;
	return result.text().trim() || null;
}

async function loadOfficialBaseProof(tag: string, canonicalRepositoryUrl: string): Promise<OfficialBaseProof> {
	const ref = `refs/tags/${tag}`;
	const localObjectId = await revParse(ref);
	const localCommitId = await revParse(`${ref}^{commit}`);
	const remote = await $`git ls-remote --tags ${canonicalRepositoryUrl} ${ref} ${`${ref}^{}`}`.quiet().nothrow();
	if (remote.exitCode !== 0) {
		throw new Error(`Failed to read ${ref} from canonical repository (git exited ${remote.exitCode})`);
	}
	const remoteRefs = new Map<string, string>();
	for (const line of remote.text().split("\n")) {
		const [objectId, remoteRef] = line.trim().split(/\s+/, 2);
		if (objectId && remoteRef) remoteRefs.set(remoteRef, objectId);
	}
	const canonicalObjectId = remoteRefs.get(ref) ?? null;
	const canonicalCommitId = remoteRefs.get(`${ref}^{}`) ?? canonicalObjectId;
	let isAncestor = false;
	if (localCommitId) {
		const ancestor = await $`git merge-base --is-ancestor ${localCommitId} HEAD`.quiet().nothrow();
		if (ancestor.exitCode === 0) isAncestor = true;
		else if (ancestor.exitCode !== 1) {
			throw new Error(`git merge-base failed for ${tag} with exit code ${ancestor.exitCode}`);
		}
	}
	return { tag, localObjectId, localCommitId, canonicalObjectId, canonicalCommitId, isAncestor };
}

function possibleT4Versions(eventName: string, ref: string, refName: string, headTags: string[]): string[] {
	if (eventName === "pull_request") return [];
	const candidates = ref === "refs/heads/t4code/main" ? [...headTags] : [];
	if (eventName === "workflow_dispatch" && ref.startsWith("refs/tags/")) {
		candidates.push(refName || ref.slice("refs/tags/".length));
	}
	return [
		...new Set(
			candidates
				.map(parseReleaseTag)
				.filter(candidate => candidate?.kind === "t4code")
				.map(candidate => candidate.version),
		),
	];
}

async function branchContainsHead(branch: "main" | "t4code/main"): Promise<boolean> {
	const ref = `refs/remotes/origin/${branch}`;
	const exists = await $`git rev-parse --verify --quiet ${ref}`.quiet().nothrow();
	if (exists.exitCode !== 0) return false;
	const contains = await $`git merge-base --is-ancestor HEAD ${ref}`.quiet().nothrow();
	if (contains.exitCode === 0) return true;
	if (contains.exitCode === 1) return false;
	throw new Error(`git merge-base failed for ${ref} with exit code ${contains.exitCode}`);
}

async function main(): Promise<void> {
	const ref = process.env.GITHUB_REF ?? "";
	const eventName = process.env.GITHUB_EVENT_NAME ?? "";
	const refName = process.env.GITHUB_REF_NAME ?? "";
	const headTags = await tagsAtHead();
	const branchesContainingHead: string[] = [];
	if (eventName === "workflow_dispatch" && ref.startsWith("refs/tags/")) {
		for (const branch of ["main", "t4code/main"] as const) {
			if (await branchContainsHead(branch)) branchesContainingHead.push(branch);
		}
	}
	const codingAgentManifest = (await Bun.file(`${import.meta.dir}/../packages/coding-agent/package.json`).json()) as {
		version?: unknown;
	};
	if (typeof codingAgentManifest.version !== "string") {
		throw new Error("packages/coding-agent/package.json has no string version");
	}
	const availableOfficialTags = await officialTags(["--list", "v*"]);
	const canonicalRepositoryUrl = resolveCanonicalRepositoryUrl(process.env);
	const officialBaseProofs = await Promise.all(
		possibleT4Versions(eventName, ref, refName, headTags).map(version =>
			loadOfficialBaseProof(`v${version}`, canonicalRepositoryUrl),
		),
	);
	const metadata = resolveReleaseMetadata({
		eventName,
		ref,
		refName,
		repository: process.env.GITHUB_REPOSITORY ?? "",
		tagsAtHead: headTags,
		branchesContainingHead,
		availableOfficialTags,
		officialBaseProofs,
		expectedVersion: codingAgentManifest.version,
	});
	const lines = [
		`is-release=${metadata.isRelease}`,
		`release-tag=${metadata.releaseTag}`,
		`release-kind=${metadata.releaseKind}`,
		`release-version=${metadata.releaseVersion}`,
	];
	const outputPath = process.env.GITHUB_OUTPUT;
	if (outputPath) {
		await fs.appendFile(outputPath, `${lines.join("\n")}\n`);
	} else {
		console.log(JSON.stringify(metadata, null, "\t"));
	}
}

if (import.meta.main) await main();
