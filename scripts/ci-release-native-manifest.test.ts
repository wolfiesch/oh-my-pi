import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createNativeReleaseManifest } from "./ci-release-native-manifest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function fixtureDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-release-manifest-"));
	temporaryDirectories.push(directory);
	await Bun.write(path.join(directory, "pi_natives.linux-x64-baseline.node"), "baseline");
	await Bun.write(path.join(directory, "pi_natives.linux-x64-modern.node"), "modern");
	return directory;
}

describe("native release manifest", () => {
	test("binds both Linux x64 release assets to their source identity and digest", async () => {
		const directory = await fixtureDirectory();
		const manifest = await createNativeReleaseManifest({
			directory,
			repository: "wolfiesch/oh-my-pi",
			commit: "a".repeat(40),
			tag: "t4code-17.0.5-appserver-17",
			sourceHash: "b".repeat(16),
		});

		expect(manifest.source).toEqual({
			repository: "wolfiesch/oh-my-pi",
			commit: "a".repeat(40),
			tag: "t4code-17.0.5-appserver-17",
			nativeSourceHash: "b".repeat(16),
		});
		expect(manifest.assets.map(({ name, size }) => ({ name, size }))).toEqual([
			{ name: "pi_natives.linux-x64-baseline.node", size: 8 },
			{ name: "pi_natives.linux-x64-modern.node", size: 6 },
		]);
		expect(manifest.assets.every(asset => /^[0-9a-f]{64}$/u.test(asset.sha256))).toBe(true);
	});

	test("rejects an incomplete release asset pair", async () => {
		const directory = await fixtureDirectory();
		await fs.rm(path.join(directory, "pi_natives.linux-x64-baseline.node"));

		await expect(
			createNativeReleaseManifest({
				directory,
				repository: "wolfiesch/oh-my-pi",
				commit: "a".repeat(40),
				tag: "t4code-17.0.5-appserver-17",
				sourceHash: "b".repeat(16),
			}),
		).rejects.toThrow("Expected baseline and modern Linux x64 native addons");
	});
});
