import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { computeNativeSourceHash, nativeBuildRecipe, nativeHashInputs } from "./ci-native-source-hash";

type Config = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dir, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
const ciTestPlanPath = path.join(repoRoot, "scripts", "ci-test-ts.ts");
const appserverManifestPath = path.join(repoRoot, "packages", "appserver", "package.json");
const workflow = Bun.YAML.parse(await Bun.file(workflowPath).text()) as Config;
const gha = (expression: string): string => `\${{ ${expression} }}`;

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
		for (const name of ["release_binary", "release_github", "release_github_verify"]) {
			const condition = job(name).if;
			expect(condition).toContain("is-release == 'true'");
			expect(condition).not.toContain("release-kind == 'upstream'");
		}
	});

	it("publishes exactly the five supported product binary assets", () => {
		const strategy = config(job("release_binary").strategy, "release_binary.strategy");
		const matrix = config(strategy.matrix, "release_binary.strategy.matrix");
		if (!Array.isArray(matrix.include)) throw new Error("release_binary.strategy.matrix.include is not a list");
		const assets = matrix.include.map((rawAsset, index) => {
			const asset = config(rawAsset, `release_binary.strategy.matrix.include.${index}`);
			return { targetId: asset.target_id, binaryPath: asset.binary_path };
		});
		expect(assets).toEqual([
			{ targetId: "linux-x64", binaryPath: "packages/coding-agent/binaries/omp-linux-x64" },
			{ targetId: "linux-arm64", binaryPath: "packages/coding-agent/binaries/omp-linux-arm64" },
			{ targetId: "darwin-x64", binaryPath: "packages/coding-agent/binaries/omp-darwin-x64" },
			{ targetId: "darwin-arm64", binaryPath: "packages/coding-agent/binaries/omp-darwin-arm64" },
			{ targetId: "win32-x64", binaryPath: "packages/coding-agent/binaries/omp-windows-x64.exe" },
		]);

		const artifactUpload = config(
			step("release_binary", "Upload release binary artifact").with,
			"binary upload inputs",
		);
		expect(artifactUpload.path).toBe(`\${{ matrix.binary_path }}`);
		const artifactDownload = config(
			step("release_github", "Download release binaries").with,
			"binary download inputs",
		);
		expect(artifactDownload.pattern).toBe("omp-binary-*");
		const releaseUpload = config(step("release_github", "Create GitHub Release").with, "GitHub release inputs");
		expect(String(releaseUpload.files).trim()).toBe("packages/coding-agent/binaries/omp-*");
	});

	it("keeps every npm mutation and Homebrew update upstream-only", () => {
		for (const name of ["release_npm", "release_brew"]) {
			expect(job(name).if).toContain("release-kind == 'upstream'");
			expect(job(name).if).toContain("github.repository == 'can1357/oh-my-pi'");
		}
		const nativePublishCondition = step("release_binary", "Publish native addon package").if;
		expect(nativePublishCondition).toContain("release-kind == 'upstream'");
		expect(nativePublishCondition).toContain("github.repository == 'can1357/oh-my-pi'");
	});

	it("feeds plain semver to notes and includes Unreleased entries for the T4 product", () => {
		const command = step("release_github", "Generate release notes from CHANGELOGs").run;
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

		const crossRunner = job("native_cross_platform_kata")["runs-on"];
		expect(crossRunner).toContain("github.repository != 'can1357/oh-my-pi'");
		expect(crossRunner).toContain("ubuntu-22.04");
		expect(crossRunner).toContain("matrix.os");
	});

	it("reuses only hash-identical native artifacts from the trusted owning branch", () => {
		const lookup = String(step("native_artifact_lookup", "Find trusted build with matching native artifacts").run);
		expect(lookup).toContain("refs/heads/t4code/main|refs/tags/t4code-*");
		expect(lookup).toContain('cache_branch="$PR_BASE_REF"');
		expect(lookup).toContain("actions/artifacts?name=$linux_canary");
		expect(lookup).toContain(".conclusion, .event, .head_branch, .path");
		expect(lookup).toContain(`"\${linux_required[@]}" "\${cross_platform_required[@]}"`);
		expect(lookup).toContain(`hash="${gha("steps.compute.outputs.source-hash")}"`);

		const linuxCondition = String(job("native_linux_x64").if);
		expect(linuxCondition).toContain("linux-x64-run-id == ''");
		expect(linuxCondition).not.toContain("is-release == 'true'");
		for (const name of ["native_cross_platform_kata", "native_cross_platform_macos"]) {
			const condition = String(job(name).if);
			expect(condition).toContain("cross-platform-run-id == ''");
			expect(condition).toContain("github.ref == 'refs/heads/t4code/main'");
		}

		const release = job("release_binary");
		expect(String(release.if)).toContain("native_artifact_lookup.outputs.linux-x64-run-id != ''");
		expect(String(release.if)).toContain("native_artifact_lookup.outputs.cross-platform-run-id != ''");
		const resolver = String(step("release_binary", "Resolve native artifact run").run);
		expect(resolver).toContain('artifact_run_id="$GITHUB_RUN_ID"');
		expect(resolver).toContain('artifact_run_id="$cached_run_id"');
		const download = config(step("release_binary", "Download native addon(s)").with, "native download inputs");
		expect(download["run-id"]).toBe(gha("steps.native-source.outputs.artifact-run-id"));
		expect(download["github-token"]).toBe(gha("secrets.GITHUB_TOKEN"));
	});

	it("hashes the complete native build recipe and keeps it aligned with the workflow", async () => {
		for (const required of [
			"package.json",
			"bun.lock",
			".github/actions/build-native/action.yml",
			".github/actions/ensure-rust-toolchain/action.yml",
		]) {
			expect(nativeHashInputs).toContain(required);
		}
		expect(await computeNativeSourceHash()).toMatch(/^[0-9a-f]{16}$/);
		expect(workflow.env).toMatchObject({ GLIBC_FLOOR: nativeBuildRecipe.glibcFloor });
		expect(job("native_linux_x64")["runs-on"]).toContain(nativeBuildRecipe.runners.kata);
		expect(job("native_linux_x64")["runs-on"]).toContain(nativeBuildRecipe.runners.linuxFallback);

		const linuxMatrix = config(config(job("native_linux_x64").strategy, "linux strategy").matrix, "linux matrix");
		expect(linuxMatrix.include).toEqual(nativeBuildRecipe.linuxX64);
		const kataMatrix = config(
			config(job("native_cross_platform_kata").strategy, "kata strategy").matrix,
			"kata matrix",
		);
		expect(kataMatrix.include).toEqual(nativeBuildRecipe.crossKata);
		const macMatrix = config(
			config(job("native_cross_platform_macos").strategy, "mac strategy").matrix,
			"mac matrix",
		);
		expect(macMatrix.include).toEqual(nativeBuildRecipe.crossMacos);
		const macBuild = config((job("native_cross_platform_macos").steps as Config[])[1].with, "mac build inputs");
		expect(macBuild.rust_tests).toBe("false");
	});

	it("runs Rust validation once in parallel with native artifact production", () => {
		const validation = job("rust_validation");
		expect(validation.needs).toBeUndefined();
		const validationMatrix = config(config(validation.strategy, "validation strategy").matrix, "validation matrix");
		expect(validationMatrix.phase).toEqual(["check", "test"]);
		expect(step("rust_validation", "Validate Rust workspace").run).toBe(
			`bun run ${gha("matrix.phase == 'check' && 'check:rs' || 'test:rs'")}`,
		);

		const native = job("native_linux_x64");
		const matrix = config(config(native.strategy, "native strategy").matrix, "native matrix");
		expect(matrix.include).toEqual([{ variant: "baseline" }, { variant: "modern" }]);
		const build = config((native.steps as Config[])[1].with, "native build inputs");
		expect(build.rust_checks).toBe("false");
		expect(build.rust_tests).toBe("false");
		expect(job("release_binary").if).toContain("needs.rust_validation.result == 'success'");
		expect(job("release_binary").needs).toContain("rust_validation");
	});

	it("resolves cached native artifacts for every release consumer", () => {
		const npmResolver = String(step("release_npm", "Resolve Linux x64 native artifact run").run);
		expect(npmResolver).toContain('artifact_run_id="$GITHUB_RUN_ID"');
		expect(npmResolver).toContain("native_artifact_lookup.outputs.linux-x64-run-id");
		const npmDownload = config(step("release_npm", "Download native addons").with, "npm native download");
		expect(npmDownload["run-id"]).toBe(gha("steps.native-source.outputs.artifact-run-id"));
		expect(npmDownload["github-token"]).toBe(gha("secrets.GITHUB_TOKEN"));
		expect(job("release_npm").needs).toContain("native_linux_x64");
		expect(config(job("release_binary").permissions, "release binary permissions").actions).toBe("read");
		expect(config(job("release_npm").permissions, "release npm permissions").actions).toBe("read");
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
		expect(job("release_binary").if).toContain("needs.test_ts_native.result == 'success'");
	});
});
