#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * Build-recipe values that are supplied by ci.yml rather than stored in the
 * native sources. The workflow contract test keeps these values in lockstep
 * with the real matrices, so changing a target, variant, or glibc floor also
 * invalidates every reusable native artifact.
 */
export const nativeBuildRecipe = {
	glibcFloor: "2.17",
	runners: {
		canonicalRepository: "can1357/oh-my-pi",
		kata: "omp-kata",
		linuxFallback: "ubuntu-22.04",
	},
	linuxX64: [{ variant: "baseline" }, { variant: "modern" }],
	crossKata: [
		{ os: "omp-kata", platform: "linux", arch: "arm64", target: "aarch64-unknown-linux-gnu" },
		{
			os: "omp-kata",
			platform: "win32",
			arch: "x64",
			target: "x86_64-pc-windows-msvc",
			variant: "baseline",
		},
	],
	crossMacos: [
		{ os: "macos-15-intel", platform: "darwin", arch: "x64", target: "", variant: "baseline" },
		{ os: "macos-14", platform: "darwin", arch: "arm64", target: "" },
	],
} as const;

/** Every checked-in input that can affect the shipped `.node` bytes. */
export const nativeHashInputs = [
	"crates",
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	"package.json",
	"bun.lock",
	"packages/natives/package.json",
	"packages/natives/scripts",
	"scripts/ci-build-native.ts",
	"scripts/ci-native-source-hash.ts",
	"scripts/host-detect.ts",
	".github/actions/build-native/action.yml",
	".github/actions/bun-install/action.yml",
	".github/actions/ensure-cargo-tool/action.yml",
	".github/actions/ensure-rust-toolchain/action.yml",
	".github/actions/ensure-sccache/action.yml",
	".github/actions/ensure-zig/action.yml",
] as const;

async function collectFiles(relativePath: string): Promise<string[]> {
	const absolutePath = path.join(repoRoot, relativePath);
	const info = await fs.stat(absolutePath);
	if (info.isFile()) return [relativePath];
	if (!info.isDirectory()) return [];

	const entries = await fs.readdir(absolutePath);
	const nested = await Promise.all(entries.map(entry => collectFiles(path.join(relativePath, entry))));
	return nested.flat();
}

export async function computeNativeSourceHash(): Promise<string> {
	const files = (await Promise.all(nativeHashInputs.map(collectFiles))).flat().sort();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`recipe\0${JSON.stringify(nativeBuildRecipe)}\0`);
	for (const relativePath of files) {
		hasher.update(relativePath);
		hasher.update("\0");
		hasher.update(await Bun.file(path.join(repoRoot, relativePath)).arrayBuffer());
		hasher.update("\0");
	}
	return hasher.digest("hex").slice(0, 16);
}

if (import.meta.main) console.log(await computeNativeSourceHash());
