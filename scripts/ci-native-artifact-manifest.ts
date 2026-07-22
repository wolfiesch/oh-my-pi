#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

interface NativeArtifactFile {
	name: string;
	sha256: string;
	size: number;
}

interface NativeArtifactManifest {
	schemaVersion: 1;
	sourceHash: string;
	workflowHash: string;
	actionPins: string[];
	artifact: {
		platform: string;
		arch: string;
		variant: string;
		target: string;
		glibc: string;
	};
	toolchain: {
		bun: string;
		rustc: string;
		cargo: string;
		zig: string | null;
	};
	files: NativeArtifactFile[];
}

interface CreateManifestOptions {
	repoRoot: string;
	directory: string;
	sourceHash: string;
	platform: string;
	arch: string;
	variant: string;
	target: string;
	glibc: string;
}

interface VerifyManifestOptions {
	repoRoot: string;
	directory: string;
	sourceHash: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ACTION_PIN_PATTERN = /^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/u;

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(filePath).arrayBuffer());
	return hasher.digest("hex");
}

async function workflowFiles(repoRoot: string): Promise<string[]> {
	const actionRoot = path.join(repoRoot, ".github", "actions");
	const workflowRoot = path.join(repoRoot, ".github", "workflows");
	const files: string[] = [];
	const pending = [actionRoot, workflowRoot];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (directory === undefined) break;
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) pending.push(entryPath);
			else if (/\.ya?ml$/u.test(entry.name)) files.push(entryPath);
		}
	}
	return files.sort();
}

async function workflowIdentity(repoRoot: string): Promise<{
	workflowHash: string;
	actionPins: string[];
}> {
	const hasher = new Bun.CryptoHasher("sha256");
	const pins = new Set<string>();
	for (const filePath of await workflowFiles(repoRoot)) {
		const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
		const source = await Bun.file(filePath).text();
		hasher.update(`${relativePath}\0${source}\0`);
		for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+).*$/gmu)) {
			const reference = match[1];
			if (reference === undefined || reference.startsWith("./")) continue;
			if (!ACTION_PIN_PATTERN.test(reference)) {
				throw new Error(`${relativePath} contains a mutable external action reference: ${reference}`);
			}
			pins.add(reference);
		}
	}
	return { workflowHash: hasher.digest("hex"), actionPins: [...pins].sort() };
}

export function commandVersion(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString().trim();
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function requireSourceHash(sourceHash: string): void {
	if (!SHA256_PATTERN.test(sourceHash)) {
		throw new Error(`native source hash must be a full lowercase SHA-256 digest, received ${sourceHash}`);
	}
}

export async function createNativeArtifactManifest(options: CreateManifestOptions): Promise<string> {
	requireSourceHash(options.sourceHash);
	const entries = await fs.readdir(options.directory, { withFileTypes: true });
	const prefix = `pi_natives.${options.platform}-${options.arch}`;
	const suffix = options.variant === "" ? ".node" : `-${options.variant}.node`;
	const names = entries
		.filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
		.map(entry => entry.name)
		.sort();
	if (names.length === 0) throw new Error(`no native binaries match ${prefix}*${suffix}`);

	const files: NativeArtifactFile[] = [];
	for (const name of names) {
		const filePath = path.join(options.directory, name);
		const stat = await fs.stat(filePath);
		files.push({ name, sha256: await sha256File(filePath), size: stat.size });
	}
	const identity = await workflowIdentity(options.repoRoot);
	const rustc = commandVersion("rustc", ["-Vv"]);
	const cargo = commandVersion("cargo", ["--version"]);
	if (rustc === null || cargo === null) throw new Error("native build manifest requires rustc and cargo identities");
	const manifest: NativeArtifactManifest = {
		schemaVersion: 1,
		sourceHash: options.sourceHash,
		workflowHash: identity.workflowHash,
		actionPins: identity.actionPins,
		artifact: {
			platform: options.platform,
			arch: options.arch,
			variant: options.variant,
			target: options.target,
			glibc: options.glibc,
		},
		toolchain: {
			bun: Bun.version,
			rustc,
			cargo,
			zig: commandVersion("zig", ["version"]),
		},
		files,
	};
	const manifestPath = path.join(
		options.directory,
		`${prefix}${options.variant === "" ? "" : `-${options.variant}`}.manifest.json`,
	);
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifestPath;
}

function parseManifest(value: unknown, manifestPath: string): NativeArtifactManifest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${manifestPath} is not a native artifact manifest`);
	}
	const manifest = value as Partial<NativeArtifactManifest>;
	const artifact = manifest.artifact;
	const toolchain = manifest.toolchain;
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.sourceHash !== "string" ||
		!SHA256_PATTERN.test(manifest.sourceHash) ||
		typeof manifest.workflowHash !== "string" ||
		!SHA256_PATTERN.test(manifest.workflowHash) ||
		!Array.isArray(manifest.actionPins) ||
		manifest.actionPins.some(pin => typeof pin !== "string" || !ACTION_PIN_PATTERN.test(pin)) ||
		artifact === undefined ||
		[artifact.platform, artifact.arch, artifact.variant, artifact.target, artifact.glibc].some(
			item => typeof item !== "string",
		) ||
		artifact.platform === "" ||
		artifact.arch === "" ||
		toolchain === undefined ||
		typeof toolchain.bun !== "string" ||
		toolchain.bun === "" ||
		typeof toolchain.rustc !== "string" ||
		toolchain.rustc === "" ||
		typeof toolchain.cargo !== "string" ||
		toolchain.cargo === "" ||
		(toolchain.zig !== null && typeof toolchain.zig !== "string") ||
		!Array.isArray(manifest.files) ||
		manifest.files.length === 0 ||
		manifest.files.some(
			file =>
				file === null ||
				typeof file !== "object" ||
				typeof file.name !== "string" ||
				typeof file.sha256 !== "string" ||
				typeof file.size !== "number",
		)
	) {
		throw new Error(`${manifestPath} has an invalid native artifact manifest schema`);
	}
	return manifest as NativeArtifactManifest;
}

export async function verifyNativeArtifactManifests(options: VerifyManifestOptions): Promise<void> {
	requireSourceHash(options.sourceHash);
	const identity = await workflowIdentity(options.repoRoot);
	const entries = await fs.readdir(options.directory, { withFileTypes: true });
	const manifestNames = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".manifest.json"))
		.map(entry => entry.name)
		.sort();
	if (manifestNames.length === 0) throw new Error("downloaded native artifacts have no provenance manifests");

	const covered = new Set<string>();
	for (const name of manifestNames) {
		const manifestPath = path.join(options.directory, name);
		const manifest = parseManifest(await Bun.file(manifestPath).json(), manifestPath);
		if (manifest.sourceHash !== options.sourceHash) throw new Error(`${name} source hash does not match`);
		if (manifest.workflowHash !== identity.workflowHash) throw new Error(`${name} workflow hash does not match`);
		if (JSON.stringify(manifest.actionPins) !== JSON.stringify(identity.actionPins)) {
			throw new Error(`${name} pinned action set does not match`);
		}
		for (const file of manifest.files) {
			if (
				typeof file.name !== "string" ||
				typeof file.sha256 !== "string" ||
				!SHA256_PATTERN.test(file.sha256) ||
				typeof file.size !== "number" ||
				!Number.isSafeInteger(file.size) ||
				file.size < 1 ||
				path.basename(file.name) !== file.name ||
				covered.has(file.name)
			) {
				throw new Error(`${name} contains an invalid or duplicate binary record`);
			}
			const filePath = path.join(options.directory, file.name);
			const stat = await fs.stat(filePath);
			if (stat.size !== file.size || (await sha256File(filePath)) !== file.sha256) {
				throw new Error(`${file.name} does not match its provenance manifest`);
			}
			covered.add(file.name);
		}
	}
	const nativeFiles = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".node"))
		.map(entry => entry.name)
		.sort();
	if (nativeFiles.length === 0 || nativeFiles.some(name => !covered.has(name))) {
		throw new Error("downloaded native artifact set is not fully covered by provenance manifests");
	}
}

function flags(args: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (name === undefined || value === undefined || !name.startsWith("--")) {
			throw new Error(`invalid native artifact manifest argument near ${name ?? "end of input"}`);
		}
		values.set(name.slice(2), value);
	}
	return values;
}

function required(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (value === undefined) throw new Error(`missing --${name}`);
	return value;
}

if (import.meta.main) {
	const [mode, ...args] = process.argv.slice(2);
	const values = flags(args);
	const repoRoot = process.cwd();
	if (mode === "create") {
		const manifestPath = await createNativeArtifactManifest({
			repoRoot,
			directory: required(values, "directory"),
			sourceHash: required(values, "source-hash"),
			platform: required(values, "platform"),
			arch: required(values, "arch"),
			variant: required(values, "variant"),
			target: required(values, "target"),
			glibc: required(values, "glibc"),
		});
		process.stdout.write(`Created ${manifestPath}\n`);
	} else if (mode === "verify") {
		await verifyNativeArtifactManifests({
			repoRoot,
			directory: required(values, "directory"),
			sourceHash: required(values, "source-hash"),
		});
		process.stdout.write("Native artifact provenance verified\n");
	} else {
		throw new Error(`expected create or verify mode, received ${mode ?? "nothing"}`);
	}
}
