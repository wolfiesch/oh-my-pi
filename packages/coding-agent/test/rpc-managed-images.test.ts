import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resolveRpcPromptImages } from "../src/modes/rpc/rpc-prompt-images.ts";
import type { RpcManagedImageRef } from "../src/modes/rpc/rpc-types.ts";

const imageId = "123e4567-e89b-42d3-a456-426614174000";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const sha256 = createHash("sha256").update(png).digest("hex");
const ref: RpcManagedImageRef = { imageId, mimeType: "image/png", size: png.byteLength, sha256 };

async function fixture(): Promise<{ parent: string; root: string; file: string }> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-image-"));
	const root = path.join(parent, "images");
	const file = path.join(root, imageId);
	await fs.mkdir(root, { mode: 0o700 });
	await fs.chmod(root, 0o700);
	await fs.writeFile(file, png, { mode: 0o600 });
	await fs.chmod(file, 0o600);
	return { parent, root, file };
}

describe("RPC managed prompt image resolution", () => {
	test("leaves stock inline images unchanged and securely reads managed spools", async () => {
		const inline: ImageContent[] = [{ type: "image", data: "AQ==", mimeType: "image/png" }];
		expect(await resolveRpcPromptImages(inline, undefined)).toBe(inline);

		const { parent, root } = await fixture();
		try {
			expect(await resolveRpcPromptImages(undefined, [ref], root)).toEqual([
				{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
			]);
			await expect(resolveRpcPromptImages(inline, [ref], root)).rejects.toThrow("Inline images cannot be combined");
			await expect(resolveRpcPromptImages(undefined, [ref, ref], root)).rejects.toThrow("must be unique");
			await expect(resolveRpcPromptImages(undefined, [{ ...ref, imageId: "../secret" }], root)).rejects.toThrow(
				"invalid identifier",
			);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("accepts a private root reached through a platform parent symlink", async () => {
		const { parent, root } = await fixture();
		const alias = `${parent}-alias`;
		try {
			await fs.symlink(parent, alias, "dir");
			expect(await resolveRpcPromptImages(undefined, [ref], path.join(alias, path.basename(root)))).toHaveLength(1);
		} finally {
			await fs.unlink(alias).catch(() => undefined);
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("rejects loose permissions, symlink files, and content declaration mismatches", async () => {
		const { parent, root, file } = await fixture();
		try {
			await fs.chmod(root, 0o755);
			await expect(resolveRpcPromptImages(undefined, [ref], root)).rejects.toThrow("root is not private");
			await fs.chmod(root, 0o700);
			await fs.chmod(file, 0o644);
			await expect(resolveRpcPromptImages(undefined, [ref], root)).rejects.toThrow("file validation");
			await fs.chmod(file, 0o600);
			await expect(resolveRpcPromptImages(undefined, [{ ...ref, sha256: "0".repeat(64) }], root)).rejects.toThrow(
				"digest validation",
			);
			await expect(resolveRpcPromptImages(undefined, [{ ...ref, mimeType: "image/jpeg" }], root)).rejects.toThrow(
				"MIME validation",
			);

			const target = path.join(parent, "target");
			await fs.rename(file, target);
			await fs.symlink(target, file);
			await expect(resolveRpcPromptImages(undefined, [ref], root)).rejects.toThrow();
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
});
