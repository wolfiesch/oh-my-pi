import { describe, expect, it } from "bun:test";
import * as path from "node:path";

type Config = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dir, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
const ciTestPlanPath = path.join(repoRoot, "scripts", "ci-test-ts.ts");
const appserverManifestPath = path.join(repoRoot, "packages", "appserver", "package.json");
const workflow = Bun.YAML.parse(await Bun.file(workflowPath).text()) as Config;

function config(value: unknown, label: string): Config {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not a mapping`);
	}
	return value as Config;
}

function job(name: string): Config {
	return config(config(workflow.jobs, "jobs")[name], `jobs.${name}`);
}

function step(jobName: string, stepName: string): Config {
	const steps = job(jobName).steps;
	if (!Array.isArray(steps)) throw new Error(`jobs.${jobName}.steps is not a list`);
	const found = steps.find(candidate => config(candidate, `jobs.${jobName}.step`).name === stepName);
	if (!found) throw new Error(`jobs.${jobName} has no step named ${stepName}`);
	return config(found, `jobs.${jobName}.steps.${stepName}`);
}

function matrixAssets(jobName: string): Array<{ targetId: unknown; binaryPath: unknown }> {
	const strategy = config(job(jobName).strategy, `${jobName}.strategy`);
	const matrix = config(strategy.matrix, `${jobName}.strategy.matrix`);
	if (!Array.isArray(matrix.include)) throw new Error(`${jobName}.strategy.matrix.include is not a list`);
	return matrix.include.map((rawAsset, index) => {
		const asset = config(rawAsset, `${jobName}.strategy.matrix.include.${index}`);
		return { targetId: asset.target_id, binaryPath: asset.binary_path };
	});
}

describe("CI workflow product release contract", () => {
	it("runs branch and pull-request validation for main and t4code/main", () => {
		const events = config(workflow.on, "on");
		for (const event of ["push", "pull_request"]) {
			expect(config(events[event], `on.${event}`).branches).toEqual(["main", "t4code/main"]);
		}
	});

	it("exports the complete release identity from the tested metadata resolver", () => {
		const metadata = job("release_metadata");
		expect(Object.keys(config(metadata.outputs, "release_metadata.outputs")).sort()).toEqual([
			"is-release",
			"release-kind",
			"release-tag",
			"release-version",
		]);
		expect(step("release_metadata", "Detect release tag at HEAD").run).toBe("bun scripts/ci-release-metadata.ts");
		const checkout = (metadata.steps as Config[])[0];
		expect(config(checkout.with, "release metadata checkout inputs")["fetch-depth"]).toBe(0);
	});

	it("publishes binaries and GitHub releases for either release kind", () => {
		for (const name of ["release_binary", "release_binary_darwin", "release_github", "release_github_verify"]) {
			const condition = String(job(name).if);
			expect(condition).toContain("is-release == 'true'");
			expect(condition).not.toContain("release-kind == 'upstream'");
		}
	});

	it("publishes every supported product binary with checksums", () => {
		expect([...matrixAssets("release_binary"), ...matrixAssets("release_binary_darwin")]).toEqual([
			{ targetId: "linux-x64", binaryPath: "packages/coding-agent/binaries/omp-linux-x64" },
			{ targetId: "linux-musl-x64", binaryPath: "packages/coding-agent/binaries/omp-linux-musl-x64" },
			{ targetId: "linux-arm64", binaryPath: "packages/coding-agent/binaries/omp-linux-arm64" },
			{ targetId: "linux-musl-arm64", binaryPath: "packages/coding-agent/binaries/omp-linux-musl-arm64" },
			{ targetId: "win32-x64", binaryPath: "packages/coding-agent/binaries/omp-windows-x64.exe" },
			{ targetId: "darwin-x64", binaryPath: "packages/coding-agent/binaries/omp-darwin-x64" },
			{ targetId: "darwin-arm64", binaryPath: "packages/coding-agent/binaries/omp-darwin-arm64" },
		]);
		for (const jobName of ["release_binary", "release_binary_darwin"]) {
			const upload = config(step(jobName, "Upload release binary artifact").with, `${jobName} upload inputs`);
			expect(upload.path).toBe(`\${{ matrix.binary_path }}`);
		}
		const releaseUpload = config(step("release_github", "Create GitHub Release").with, "GitHub release inputs");
		expect(String(releaseUpload.files)).toContain("packages/coding-agent/binaries/omp-*");
		expect(String(releaseUpload.files)).toContain("SHA256SUMS.txt");
		expect(step("release_github", "Generate checksums").run).toContain("packages/coding-agent/binaries/omp-*");
	});

	it("keeps npm mutations and Homebrew updates upstream-only", () => {
		for (const name of ["release_native_leaves", "release_npm", "release_brew"]) {
			const condition = String(job(name).if);
			expect(condition).toContain("release-kind == 'upstream'");
			expect(condition).toContain("github.repository == 'can1357/oh-my-pi'");
		}
	});

	it("feeds plain semver to notes and includes Unreleased entries for the T4 product", () => {
		const command = String(step("release_github", "Generate release notes from CHANGELOGs").run);
		expect(command).toContain("release-version");
		expect(command).toContain('release-kind }}" = "t4code"');
		expect(command).toContain("--include-unreleased");
	});

	it("routes fork jobs away from the upstream-only omp-kata runner", () => {
		let upstreamOnlyRunnerJobs = 0;
		for (const [name, rawJob] of Object.entries(config(workflow.jobs, "jobs"))) {
			const runsOn = config(rawJob, `jobs.${name}`)["runs-on"];
			if (typeof runsOn !== "string" || !runsOn.includes("omp-kata")) continue;
			upstreamOnlyRunnerJobs++;
			expect(runsOn).toContain("github.repository != 'can1357/oh-my-pi'");
			expect(runsOn).toContain("ubuntu-22.04");
		}
		expect(upstreamOnlyRunnerJobs).toBeGreaterThan(0);
	});

	it("builds native artifacts through the upstream Bazel pipeline", () => {
		const build = String(step("native_addons", "Build native addons once").run);
		expect(job("native_addons").needs).toContain("release_metadata");
		expect(build).toContain("github.repository == 'can1357/oh-my-pi'");
		expect(build).toContain("needs.release_metadata.outputs.is-release == 'true'");
		expect(build).toContain("natives-linux-x64-baseline");
		expect(build).toContain("natives-linux-x64-modern");
		expect(build).toContain("natives-win32-x64-baseline");
		const upload = config(step("native_addons", "Upload native addon artifacts").with, "native upload inputs");
		expect(upload.name).toBe("native-addons");
		expect(upload.path).toBe("bazel-bin/natives-*/*.node");
		const cacheSave = config(step("native_addons", "Save bazel disk cache").with, "native cache save inputs");
		expect(cacheSave.key).toBe(`\${{ steps.cache.outputs.cache-key }}`);
		expect(String(cacheSave.path)).toContain("~/.cache/omp-bazel-disk");
		for (const consumer of [
			"test_workspace",
			"test_coding_agent_singleton",
			"test_ts_native",
			"test_coding_agent_ui",
			"test_coding_agent_runtime",
			"test_coding_agent_native",
			"test_smoke",
			"install_methods",
		]) {
			const uses = (job(consumer).steps as Config[]).map(candidate => candidate.uses);
			expect(uses).toContain("./.github/actions/native-artifacts");
		}
	});

	it("validates Rust through the upstream Bazel checks", () => {
		const validation = job("rust_validate");
		expect(validation.needs).toBeUndefined();
		expect(step("rust_validate", "Rust tests").run).toContain("bazelisk");
		expect(step("rust_validate", "Rustfmt").run).toContain("--config=rustfmt");
		expect(job("release_gate").if).toContain("needs.rust_validate.result == 'success'");
	});

	it("gates appserver types and runtime tests before publishing product binaries", async () => {
		const manifest = config(await Bun.file(appserverManifestPath).json(), "appserver manifest");
		expect(config(manifest.scripts, "appserver scripts").check).toBe("bun run build");

		const dryRun = Bun.spawnSync(["bun", ciTestPlanPath, "native", "--dry-run"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(dryRun.exitCode).toBe(0);
		expect(dryRun.stdout.toString()).toContain("==> packages/appserver");
		expect(job("release_github").needs).toContain("release_gate");
		expect(job("release_gate").if).toContain("needs.test_ts_native.result == 'success'");
	});
});
