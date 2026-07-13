import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secureListDirectory, secureReadFile, secureWriteFileAtomic } from "../native/index.js";

const roots: string[] = [];

async function rootFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-secure-fs-test-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("secure file jail native API", () => {
	it("round-trips binary bytes and revision guarded replacement", async () => {
		const root = await rootFixture();
		const first = secureWriteFileAtomic(root, "nested.bin", Buffer.from([0, 1, 255, 2]), null, 1024);
		expect(first.size).toBe(4);
		const read = secureReadFile(root, "nested.bin", 1024);
		expect(Buffer.from(read.data).equals(Buffer.from([0, 1, 255, 2]))).toBe(true);
		expect(read.revisionSha256).toBe(first.revisionSha256);
		const replaced = secureWriteFileAtomic(root, "nested.bin", Buffer.from([9]), first.revisionSha256, 1024);
		expect(replaced.size).toBe(1);
		expect(() => secureWriteFileAtomic(root, "nested.bin", Buffer.from([8]), first.revisionSha256, 1024)).toThrow(
			/CONFLICT/,
		);
		expect((await readFile(path.join(root, "nested.bin"))).equals(Buffer.from([9]))).toBe(true);
	});

	it("rejects traversal, absolute, drive, NUL, and over-limit paths without redaction leaks", async () => {
		const root = await rootFixture();
		for (const relative of ["../outside", "/tmp/outside", "C:/outside", "C:outside", "bad\0name", "a\\b"]) {
			expect(() => secureReadFile(root, relative, 1024)).toThrow(/UNSAFE_PATH/);
		}
		expect(() => secureReadFile(root, "missing", 0)).toThrow(/BOUNDS/);
		expect(() => secureReadFile(root, "missing", 1024)).toThrow(/NOT_FOUND/);
		try {
			secureReadFile(root, "missing", 1024);
		} catch (error) {
			expect(String(error)).not.toContain(root);
			expect(String(error)).not.toContain("missing");
		}
	});

	it("lists sorted entries and enforces the iteration cap", async () => {
		const root = await rootFixture();
		await writeFile(path.join(root, "z"), "z");
		await writeFile(path.join(root, "a"), "a");
		const listed = secureListDirectory(root, null, 10);
		expect(listed.entries.map(entry => entry.name)).toEqual(["a", "z"]);
		expect(listed.entries.map(entry => entry.path)).toEqual(["a", "z"]);
		expect(() => secureListDirectory(root, null, 1)).toThrow(/BOUNDS/);
	});

	it("rejects final and parent symlinks", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const outside = await mkdtemp(path.join(os.tmpdir(), "pi-secure-fs-outside-"));
		try {
			await writeFile(path.join(outside, "secret"), "secret");
			await symlink(path.join(outside, "secret"), path.join(root, "link"));
			await symlink(outside, path.join(root, "dir-link"));
			expect(() => secureReadFile(root, "link", 1024)).toThrow(/UNSAFE_PATH/);
			expect(() => secureReadFile(root, "dir-link/secret", 1024)).toThrow(/UNSAFE_PATH/);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("rejects directory reads and write overwrite without a revision", async () => {
		const root = await rootFixture();
		expect(() => secureReadFile(root, ".", 1024)).toThrow(/UNSAFE_PATH/);
		await writeFile(path.join(root, "file"), "old");
		expect(() => secureReadFile(root, "file", 2)).toThrow(/BOUNDS/);
		expect(() => secureWriteFileAtomic(root, "file", Buffer.from("new"), null, 1024)).toThrow(/CONFLICT/);
	});
});
