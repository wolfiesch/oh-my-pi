import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

interface SessionCandidate {
	file: string | null;
	mtimeMs: number;
}

async function newestSessionFileInDir(dir: string, current: SessionCandidate): Promise<SessionCandidate> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return current;
	}

	let newest = current;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.endsWith(".bak")) continue;
		const fullPath = path.join(dir, entry.name);
		try {
			const stat = await fs.stat(fullPath);
			if (stat.mtimeMs > newest.mtimeMs) newest = { file: fullPath, mtimeMs: stat.mtimeMs };
		} catch {}
	}
	return newest;
}

/**
 * Find the most recent top-level session file under the active profile's
 * sessions directory. Main sessions live one project directory below the root;
 * root-level files are accepted for older layouts, but nested artifact
 * directories are intentionally not scanned so subagent logs cannot become the
 * active main session.
 */
export async function findActiveMainSession(): Promise<string | null> {
	const sessionsDir = getSessionsDir();
	let newest: SessionCandidate = { file: null, mtimeMs: 0 };
	newest = await newestSessionFileInDir(sessionsDir, newest);

	let entries: Dirent[];
	try {
		entries = await fs.readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return newest.file;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		newest = await newestSessionFileInDir(path.join(sessionsDir, entry.name), newest);
	}
	return newest.file;
}

/**
 * Get the subagent artifacts directory for a given main session file.
 */
export function getSubagentDir(mainSessionFile: string): string {
	return mainSessionFile.slice(0, -6);
}
