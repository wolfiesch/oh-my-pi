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
			repository: "https://github.com/wolfiesch/omperator.git",
			commit: "7a9e73f264253142db6f348298a9426929137656",
			tree: "4d99f8af4e02e915a27404eee9a823612a92a340",
		});
		for (const artifact of manifest.packages) {
			expect(artifact.file).toMatch(/^t4-code-host-(?:service|wire)-0\.1\.31(?:-[0-9a-f]{7})?\.tgz$/u);
			const digest = new Bun.CryptoHasher("sha256")
				.update(await Bun.file(resolve(vendor, artifact.file)).arrayBuffer())
				.digest("hex");
			expect(digest).toBe(artifact.sha256);
		}
	});
});
