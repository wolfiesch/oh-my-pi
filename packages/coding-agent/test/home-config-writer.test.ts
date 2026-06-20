import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyConfigEdits, readConfigDoc } from "@oh-my-pi/pi-coding-agent/config/config-writer";

async function tmpConfig(initial: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-writer-"));
	const file = path.join(dir, "config.yml");
	await Bun.write(file, initial);
	return file;
}

describe("config-writer.applyConfigEdits", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true })));
		dirs.length = 0;
	});

	it("preserves comments on untouched keys when setting a nested value", async () => {
		const initial = `# top-level comment about roles
# another comment line
modelRoles:
  default: anthropic/claude-opus-4-8:high
  smol: anthropic/claude-haiku-4-5:medium

# cycle order comment
cycleOrder:
  - smol
  - default
  - slow
`;
		const file = await tmpConfig(initial);
		dirs.push(path.dirname(file));

		await applyConfigEdits(file, [{ path: "modelRoles.smol", value: "zai/glm-5.2:minimal" }]);

		const written = await Bun.file(file).text();
		// Comments must survive.
		expect(written).toContain("# top-level comment about roles");
		expect(written).toContain("# cycle order comment");
		// The edited value changed.
		expect(written).toContain("zai/glm-5.2:minimal");
		// The untouched sibling is byte-identical.
		expect(written).toContain("default: anthropic/claude-opus-4-8:high");
		// cycleOrder block is unchanged.
		expect(written).toContain("  - smol\n  - default\n  - slow");
	});

	it("deletes a key (value undefined) while keeping siblings and comments", async () => {
		const initial = `# roles
modelRoles:
  default: a/b
  smol: c/d
  slow: e/f
`;
		const file = await tmpConfig(initial);
		dirs.push(path.dirname(file));

		await applyConfigEdits(file, [{ path: "modelRoles.smol", value: undefined }]);

		const written = await Bun.file(file).text();
		expect(written).toContain("# roles");
		expect(written).toContain("default: a/b");
		expect(written).toContain("slow: e/f");
		expect(written).not.toContain("smol: c/d");
	});

	it("replaces an array value in place", async () => {
		const initial = `cycleOrder:
  - smol
  - default
  - slow
`;
		const file = await tmpConfig(initial);
		dirs.push(path.dirname(file));

		await applyConfigEdits(file, [{ path: "cycleOrder", value: ["smol", "default"] }]);

		const doc = await readConfigDoc(file);
		expect(doc.cycleOrder).toEqual(["smol", "default"]);
	});

	it("applies multiple edits atomically in one round-trip", async () => {
		const initial = `modelRoles:
  default: a/b
enabledModels: []
`;
		const file = await tmpConfig(initial);
		dirs.push(path.dirname(file));

		await applyConfigEdits(file, [
			{ path: "modelRoles.default", value: "x/y:high" },
			{ path: "enabledModels", value: ["x/y", "z/w"] },
			{ path: "compaction.enabled", value: true },
		]);

		const doc = await readConfigDoc(file);
		expect(doc.modelRoles).toEqual({ default: "x/y:high" });
		expect(doc.enabledModels).toEqual(["x/y", "z/w"]);
		expect(doc.compaction).toEqual({ enabled: true });
	});

	it("starts from a header comment when the file is empty/missing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-writer-"));
		dirs.push(dir);
		const file = path.join(dir, "config.yml");
		// No file written yet — missing.

		await applyConfigEdits(file, [{ path: "modelRoles.default", value: "a/b" }]);

		const written = await Bun.file(file).text();
		expect(written).toContain("managed by omp home");
		expect(written).toContain("a/b");
	});

	it("throws on an unparseable YAML file rather than silently rewriting", async () => {
		const initial = "modelRoles: [unclosed\n  - bad\n";
		const file = await tmpConfig(initial);
		dirs.push(path.dirname(file));

		await expect(applyConfigEdits(file, [{ path: "modelRoles.default", value: "a/b" }])).rejects.toThrow(
			/Cannot edit/,
		);
	});
});
