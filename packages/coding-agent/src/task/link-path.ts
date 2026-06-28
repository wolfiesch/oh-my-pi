import * as path from "node:path";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;

export function spawnedAgentSessionLinkPath(
	parentSessionFile: string | null | undefined,
	agentId: string,
): string | undefined {
	if (!parentSessionFile) return undefined;
	return path.join(parentSessionFile.slice(0, -JSONL_SUFFIX_LENGTH), `${agentId}.jsonl`);
}
