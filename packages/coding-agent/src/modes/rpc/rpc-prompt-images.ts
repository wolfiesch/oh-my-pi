import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { IMAGE_UPLOAD_MAX_BYTES, PROMPT_IMAGE_MAX_COUNT, PROMPT_IMAGE_MIME_TYPES } from "@oh-my-pi/app-wire";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { RpcManagedImageRef } from "./rpc-types";

export const RPC_APP_IMAGE_ROOT_ENV = "OMP_APP_RPC_IMAGE_ROOT";

function rpcImageMimeType(data: Uint8Array): RpcManagedImageRef["mimeType"] | undefined {
	if (
		data.length >= 8 &&
		data[0] === 0x89 &&
		data[1] === 0x50 &&
		data[2] === 0x4e &&
		data[3] === 0x47 &&
		data[4] === 0x0d &&
		data[5] === 0x0a &&
		data[6] === 0x1a &&
		data[7] === 0x0a
	)
		return "image/png";
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	const signature = new TextDecoder().decode(data.subarray(0, 12));
	if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
	if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

function validateManagedImageRef(value: RpcManagedImageRef, index: number): RpcManagedImageRef {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Managed image reference ${index} is invalid`);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.imageId))
		throw new Error(`Managed image reference ${index} has an invalid identifier`);
	if (!(PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(value.mimeType))
		throw new Error(`Managed image reference ${index} has an unsupported MIME type`);
	if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > IMAGE_UPLOAD_MAX_BYTES)
		throw new Error(`Managed image reference ${index} has an invalid size`);
	if (!/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`Managed image reference ${index} has an invalid digest`);
	return value;
}

/** Resolve trusted appserver spool handles only after validating every filesystem boundary. */
export async function resolveRpcPromptImages(
	inlineImages: ImageContent[] | undefined,
	managedRefs: RpcManagedImageRef[] | undefined,
	root = process.env[RPC_APP_IMAGE_ROOT_ENV],
): Promise<ImageContent[] | undefined> {
	if (managedRefs === undefined) return inlineImages;
	if (inlineImages !== undefined && inlineImages.length > 0)
		throw new Error("Inline images cannot be combined with managed appserver images");
	if (managedRefs.length === 0 || managedRefs.length > PROMPT_IMAGE_MAX_COUNT)
		throw new Error("Managed appserver image count is invalid");
	if (!root || !path.isAbsolute(root)) throw new Error("Managed appserver image root is unavailable");
	const resolvedRoot = path.resolve(root);
	const rootInfo = await fs.promises.lstat(resolvedRoot);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o777) !== 0o700)
		throw new Error("Managed appserver image root is not private");
	const uid = process.getuid?.();
	if (uid !== undefined && rootInfo.uid !== uid) throw new Error("Managed appserver image root has another owner");
	const canonicalRoot = await fs.promises.realpath(resolvedRoot);

	const seen = new Set<string>();
	const images: ImageContent[] = [];
	for (const [index, raw] of managedRefs.entries()) {
		const ref = validateManagedImageRef(raw, index);
		if (seen.has(ref.imageId)) throw new Error("Managed appserver image references must be unique");
		seen.add(ref.imageId);
		const filePath = path.join(canonicalRoot, ref.imageId);
		const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const info = await handle.stat();
			if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size !== ref.size)
				throw new Error(`Managed appserver image ${index} failed file validation`);
			if (uid !== undefined && info.uid !== uid)
				throw new Error(`Managed appserver image ${index} has another owner`);
			const data = await handle.readFile();
			if (data.byteLength !== ref.size) throw new Error(`Managed appserver image ${index} changed while reading`);
			if (createHash("sha256").update(data).digest("hex") !== ref.sha256)
				throw new Error(`Managed appserver image ${index} failed digest validation`);
			if (rpcImageMimeType(data) !== ref.mimeType)
				throw new Error(`Managed appserver image ${index} failed MIME validation`);
			images.push({ type: "image", data: data.toString("base64"), mimeType: ref.mimeType });
		} finally {
			await handle.close();
		}
	}
	return images;
}
