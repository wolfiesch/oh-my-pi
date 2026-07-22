import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	commandVersion,
	createNativeArtifactManifest,
	verifyNativeArtifactManifests,
} from "./ci-native-artifact-manifest";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true })));
});

async function fixture(): Promise<{ repoRoot: string; nativeDirectory: string }> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-manifest-"));
	temporaryRoots.push(repoRoot);
	const nativeDirectory = path.join(repoRoot, "packages", "natives", "native");
	await fs.mkdir(path.join(repoRoot, ".github", "workflows"), { recursive: true });
	await fs.mkdir(path.join(repoRoot, ".github", "actions", "build-native"), { recursive: true });
	await fs.mkdir(nativeDirectory, { recursive: true });
	await Bun.write(
		path.join(repoRoot, ".github", "workflows", "ci.yml"),
		"steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n",
	);
	await Bun.write(
		path.join(repoRoot, ".github", "actions", "build-native", "action.yml"),
		"runs:\n  using: composite\n  steps: []\n",
	);
	await Bun.write(path.join(nativeDirectory, "pi_natives.linux-x64-baseline.node"), "native");
	return { repoRoot, nativeDirectory };
}

describe("native artifact provenance manifests", () => {
	test("treats an unavailable optional toolchain executable as absent", () => {
		expect(commandVersion("omp-definitely-missing-toolchain", ["--version"])).toBeNull();
	});

	test("bind downloaded binaries to the source, workflow, actions, and toolchains", async () => {
		const { repoRoot, nativeDirectory } = await fixture();
		const sourceHash = "a".repeat(64);
		await createNativeArtifactManifest({
			repoRoot,
			directory: nativeDirectory,
			sourceHash,
			platform: "linux",
			arch: "x64",
			variant: "baseline",
			target: "",
			glibc: "2.17",
		});
		await verifyNativeArtifactManifests({ repoRoot, directory: nativeDirectory, sourceHash });

		await Bun.write(path.join(nativeDirectory, "pi_natives.linux-x64-baseline.node"), "tampered");
		expect(verifyNativeArtifactManifests({ repoRoot, directory: nativeDirectory, sourceHash })).rejects.toThrow(
			"does not match its provenance manifest",
		);
	}, 30_000);

	test("rejects mutable third-party action references before publication", async () => {
		const { repoRoot, nativeDirectory } = await fixture();
		await Bun.write(path.join(repoRoot, ".github", "workflows", "ci.yml"), "steps:\n  - uses: actions/checkout@v4\n");
		expect(
			createNativeArtifactManifest({
				repoRoot,
				directory: nativeDirectory,
				sourceHash: "b".repeat(64),
				platform: "linux",
				arch: "x64",
				variant: "baseline",
				target: "",
				glibc: "2.17",
			}),
		).rejects.toThrow("mutable external action reference");
	});
});
