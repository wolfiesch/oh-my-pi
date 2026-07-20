import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface VendorManifest {
	readonly schemaVersion: number;
	readonly source: { readonly repository: string; readonly commit: string; readonly tree: string };
	readonly packages: readonly {
		readonly name: string;
		readonly version: string;
		readonly file: string;
		readonly sha256: string;
	}[];
}

describe("vendored T4 host artifacts", () => {
	test("match their pinned source and checksums", async () => {
		const root = resolve(import.meta.dir, "../../..");
		const vendor = resolve(root, "vendor/t4-host");
		const manifest = (await Bun.file(resolve(vendor, "manifest.json")).json()) as VendorManifest;
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.source).toEqual({
			repository: "https://github.com/LycaonLLC/t4-code.git",
			commit: "b04b3115022cc74157cabc1eaba7d042e1f6c8be",
			tree: "d37afe01c11bad8e61e780824b14d3cf03b069b8",
		});
		for (const artifact of manifest.packages) {
			expect(artifact.file).toMatch(/^t4-code-host-(?:service|wire)-0\.1\.30\.tgz$/u);
			const digest = new Bun.CryptoHasher("sha256")
				.update(await Bun.file(resolve(vendor, artifact.file)).arrayBuffer())
				.digest("hex");
			expect(digest).toBe(artifact.sha256);
		}
	});
});
