/**
 * Top-level command names and aliases needed during profile bootstrap.
 *
 * Keep this module limited to static data: profile selection runs before the
 * full command registry may be loaded.
 */
export const SUBCOMMANDS = [
	{ name: "launch" },
	{ name: "acp" },
	{ name: "auth-broker" },
	{ name: "auth-gateway" },
	{ name: "agents" },
	{ name: "bench" },
	{ name: "commit" },
	{ name: "completions" },
	{ name: "__complete" },
	{ name: "config" },
	{ name: "dry-balance" },
	{ name: "gc" },
	{ name: "grep" },
	{ name: "gallery" },
	{ name: "grievances" },
	{ name: "install" },
	{ name: "join" },
	{ name: "models" },
	{ name: "plugin" },
	{ name: "say" },
	{ name: "setup" },
	{ name: "shell" },
	{ name: "read" },
	{ name: "ssh" },
	{ name: "stats" },
	{ name: "update" },
	{ name: "usage" },
	{ name: "tiny-models" },
	{ name: "token" },
	{ name: "ttsr" },
	{ name: "worktree", aliases: ["wt"] },
	{ name: "search", aliases: ["q"] },
] as const;

export type SubcommandName = (typeof SUBCOMMANDS)[number]["name"];

const SUBCOMMAND_LOOKUP = new Set<string>(
	SUBCOMMANDS.flatMap(command => [command.name, ...("aliases" in command ? command.aliases : [])]),
);

export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return SUBCOMMAND_LOOKUP.has(first);
}
