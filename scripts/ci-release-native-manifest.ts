#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

interface NativeAsset {
	name: string;
	sha256: string;
	size: number;
}

interface NativeReleaseManifest {
	schemaVersion: 1;
	source: {
		repository: string;
		commit: string;
		tag: string;
		nativeSourceHash: string;
	};
	assets: NativeAsset[];
}

interface ManifestOptions {
	directory: string;
	repository: string;
	commit: string;
	tag: string;
	sourceHash: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Buffer.from(digest).toString("hex");
}

export async function createNativeReleaseManifest(options: ManifestOptions): Promise<NativeReleaseManifest> {
	if (!/^[0-9a-f]{40}$/u.test(options.commit)) {
		throw new Error(`Invalid source commit: ${options.commit}`);
	}
	if (!/^[0-9a-f]{16,64}$/u.test(options.sourceHash)) {
		throw new Error(`Invalid native source hash: ${options.sourceHash}`);
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository)) {
		throw new Error(`Invalid source repository: ${options.repository}`);
	}
	if (!options.tag) throw new Error("Release tag is required");

	const entries = (await fs.readdir(options.directory))
		.filter(name => /^pi_natives\.linux-x64-(?:baseline|modern)\.node$/u.test(name))
		.sort();
	if (entries.length !== 2) {
		throw new Error(`Expected baseline and modern Linux x64 native addons, found: ${entries.join(", ") || "none"}`);
	}

	const assets = await Promise.all(
		entries.map(async (name): Promise<NativeAsset> => {
			const bytes = await fs.readFile(path.join(options.directory, name));
			return { name, sha256: await sha256(bytes), size: bytes.byteLength };
		}),
	);

	return {
		schemaVersion: 1,
		source: {
			repository: options.repository,
			commit: options.commit,
			tag: options.tag,
			nativeSourceHash: options.sourceHash,
		},
		assets,
	};
}

function parseArguments(argv: string[]): ManifestOptions & { output: string } {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument list near ${key ?? "<end>"}`);
		values.set(key.slice(2), value);
	}
	const required = ["directory", "output", "repository", "commit", "tag", "source-hash"] as const;
	for (const key of required) {
		if (!values.get(key)) throw new Error(`Missing --${key}`);
	}
	return {
		directory: values.get("directory")!,
		output: values.get("output")!,
		repository: values.get("repository")!,
		commit: values.get("commit")!,
		tag: values.get("tag")!,
		sourceHash: values.get("source-hash")!,
	};
}

if (import.meta.main) {
	const { output, ...options } = parseArguments(Bun.argv.slice(2));
	const manifest = await createNativeReleaseManifest(options);
	await Bun.write(output, `${JSON.stringify(manifest, null, 2)}\n`);
}
