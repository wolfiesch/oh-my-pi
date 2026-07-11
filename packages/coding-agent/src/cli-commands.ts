/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. New subcommands need a static name entry in
 * `cli/subcommands.ts` and a matching loader here. The typed loader map keeps
 * those two pieces in sync — see #1496 for the original "args silently leak
 * to the LLM" regression that motivated the split.
 */
import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";
import { flagConsumesValue } from "./cli/flag-tables";
import { isSubcommand, SUBCOMMANDS, type SubcommandName } from "./cli/subcommands";

export { isSubcommand } from "./cli/subcommands";

const commandLoaders = {
	launch: () => import("./commands/launch").then(m => m.default),
	acp: () => import("./commands/acp").then(m => m.default),
	"auth-broker": () => import("./commands/auth-broker").then(m => m.default),
	"auth-gateway": () => import("./commands/auth-gateway").then(m => m.default),
	agents: () => import("./commands/agents").then(m => m.default),
	bench: () => import("./commands/bench").then(m => m.default),
	commit: () => import("./commands/commit").then(m => m.default),
	completions: () => import("./commands/completions").then(m => m.default),
	__complete: () => import("./commands/complete").then(m => m.default),
	config: () => import("./commands/config").then(m => m.default),
	"dry-balance": () => import("./commands/dry-balance").then(m => m.default),
	gc: () => import("./commands/gc").then(m => m.default),
	grep: () => import("./commands/grep").then(m => m.default),
	gallery: () => import("./commands/gallery").then(m => m.default),
	grievances: () => import("./commands/grievances").then(m => m.default),
	install: () => import("./commands/install").then(m => m.default),
	join: () => import("./commands/join").then(m => m.default),
	models: () => import("./commands/models").then(m => m.default),
	plugin: () => import("./commands/plugin").then(m => m.default),
	say: () => import("./commands/say").then(m => m.default),
	setup: () => import("./commands/setup").then(m => m.default),
	shell: () => import("./commands/shell").then(m => m.default),
	read: () => import("./commands/read").then(m => m.default),
	ssh: () => import("./commands/ssh").then(m => m.default),
	stats: () => import("./commands/stats").then(m => m.default),
	update: () => import("./commands/update").then(m => m.default),
	usage: () => import("./commands/usage").then(m => m.default),
	"tiny-models": () => import("./commands/tiny-models").then(m => m.default),
	token: () => import("./commands/token").then(m => m.default),
	ttsr: () => import("./commands/ttsr").then(m => m.default),
	worktree: () => import("./commands/worktree").then(m => m.default),
	search: () => import("./commands/web-search").then(m => m.default),
} satisfies Record<SubcommandName, CommandEntry["load"]>;

export const commands: CommandEntry[] = SUBCOMMANDS.map(command => ({
	name: command.name,
	load: commandLoaders[command.name],
	...("aliases" in command ? { aliases: [...command.aliases] } : {}),
}));

// Documented-looking plugin-management verbs that are NOT registered top-level
// commands. Without a guard `resolveCliArgv` rewrites e.g. `omp list` to
// `omp launch list`, silently forwarding the bare verb to the model as a prompt
// instead of managing plugins (#2935; same class as the `install` leak fixed in
// #1496/#1498). A bare (single-arg) use gets a hint pointing at the real
// `omp plugin <action>` command; multi-word invocations still fall through to
// `launch`, so genuine prompts that merely begin with one of these words work.
const RESERVED_TOP_LEVEL_WORDS = new Map<string, string>([
	[
		"extensions",
		'`omp extensions` is not a management command. Use `omp plugin list` / `omp plugin install`, or run `omp launch extensions` if you meant to send "extensions" as a prompt.',
	],
	[
		"list",
		'`omp list` is not a top-level command. Use `omp plugin list` to list installed plugins, or run `omp launch list` if you meant to send "list" as a prompt.',
	],
	[
		"remove",
		'`omp remove` is not a top-level command. Use `omp plugin uninstall <name>` to remove a plugin, or run `omp launch remove` if you meant to send "remove" as a prompt.',
	],
]);

export function reservedTopLevelWordMessage(first: string | undefined, argc = 1): string | undefined {
	if (argc !== 1 || !first || first.startsWith("-") || first.startsWith("@")) return undefined;
	return RESERVED_TOP_LEVEL_WORDS.get(first);
}

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command with the flags preserved, and forward everything else to
 * `launch` (#2970).
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(first, argv.length);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`omp --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front and keep the leading flags as its own
	// argv; the command's parser then applies them. Genuine launch prompts (no
	// trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		return { argv: [argv[subIndex], ...argv.slice(0, subIndex), ...argv.slice(subIndex + 1)] };
	}
	return { argv: ["launch", ...argv] };
}
