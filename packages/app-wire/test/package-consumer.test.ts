import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

async function run(command: string[], cwd: string): Promise<void> {
	const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0)
		throw new Error(`Command ${JSON.stringify(command)} failed with exit ${exitCode}\n${stdout}${stderr}`);
}

test("packed package typechecks under NodeNext and executes through its public export", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "app-wire-consumer-"));
	try {
		const packDir = path.join(tempDir, "packed");
		const consumerDir = path.join(tempDir, "consumer");
		await fs.mkdir(packDir);
		await fs.mkdir(consumerDir);
		await run([process.execPath, "pm", "pack", "--quiet", "--destination", packDir], packageDir);
		const tarballs = (await fs.readdir(packDir)).filter(name => name.endsWith(".tgz"));
		expect(tarballs).toHaveLength(1);
		const tarball = path.join(packDir, tarballs[0]!);

		await Bun.write(
			path.join(consumerDir, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: { "@oh-my-pi/app-wire": `file:${tarball}` },
			}),
		);
		await Bun.write(
			path.join(consumerDir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2024",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					exactOptionalPropertyTypes: true,
					noUncheckedIndexedAccess: true,
					noEmit: true,
					lib: ["ES2024", "DOM"],
				},
				include: ["index.ts"],
			}),
		);
		await Bun.write(
			path.join(consumerDir, "index.ts"),
			`import { decodeCommandResult } from "@oh-my-pi/app-wire/command.js";
import {
	APP_WIRE_VERSION,
	type AppFrame,
	type CommandFrame,
	commandId,
	decodeClientFrame,
	hostId,
	requestId,
} from "@oh-my-pi/app-wire";

const command: CommandFrame = {
	v: "omp-app/1",
	type: "command",
	requestId: requestId("request"),
	commandId: commandId("command"),
	hostId: hostId("host"),
	command: "session.create",
	args: { projectId: "project" },
};
const decoded: AppFrame = decodeClientFrame(command);
if (decoded.type !== "command" || decoded.command !== "session.create" || APP_WIRE_VERSION.length === 0)
	throw new Error("packed app-wire public export did not execute");
if (decodeCommandResult("session.cancel", { cancelled: true }).cancelled !== true)
	throw new Error("packed app-wire .js subpath export did not execute");
`,
		);

		await run([process.execPath, "install", "--ignore-scripts"], consumerDir);
		await run([process.execPath, tscPath, "--project", "tsconfig.json"], consumerDir);
		await run([process.execPath, "run", "index.ts"], consumerDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}, 30_000);
