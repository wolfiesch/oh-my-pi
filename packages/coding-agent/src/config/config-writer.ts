/**
 * Comment-preserving config.yml writer.
 *
 * The live `Settings.#saveNow()` path round-trips through `YAML.stringify`,
 * which strips every comment. The giga/superswipe config files are heavily
 * commented (operator documentation, role explanations), so the OMP Home web
 * UI must not shred them on edit.
 *
 * This module edits a config.yml in place using the eemeli `yaml` document
 * model, which preserves comments and formatting on untouched keys. It is the
 * SINGLE mutation path the OMP Home server uses; `Settings.#saveNow()` is
 * intentionally left on its comment-stripping serializer (out of scope).
 */

import { type Document, parseDocument } from "yaml";
import { withFileLock } from "./file-lock";

/** A single config edit. `value === undefined` deletes the key. */
export interface ConfigEdit {
	/** Dot-delimited setting path (e.g. `modelRoles.smol`). */
	path: string;
	/** New value; `undefined` removes the key. */
	value: unknown;
}

const CONFIG_HEADER = `# OMP agent config (managed by omp home)`;

function toJSValue(value: unknown): unknown {
	// The eemeli `yaml` lib accepts plain JS values; arrays/records/strings/
	// numbers/booleans round-trip correctly via doc.setIn. We hand it the raw
	// value and let the document model serialize it.
	return value;
}

function applyEdit(doc: Document.Parsed, edit: ConfigEdit): void {
	const segments = edit.path.split(".");
	if (segments.length === 0 || (segments.length === 1 && segments[0] === "")) return;
	if (edit.value === undefined) {
		doc.deleteIn(segments);
		return;
	}
	doc.setIn(segments, toJSValue(edit.value));
}

/**
 * Read a config.yml into a plain JS object for display. Missing or unparseable
 * files yield `{}`. Does not touch the comment-preserving document model.
 */
export async function readConfigDoc(configPath: string): Promise<Record<string, unknown>> {
	try {
		const text = await Bun.file(configPath).text();
		const parsed = parseDocument(text).toJS();
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Apply a batch of edits to a config.yml atomically, preserving comments and
 * formatting on untouched keys. All edits apply under a single file lock and a
 * single document round-trip. Empty/missing files start from a header comment.
 */
export async function applyConfigEdits(configPath: string, edits: readonly ConfigEdit[]): Promise<void> {
	if (edits.length === 0) return;

	await withFileLock(configPath, async () => {
		let text = "";
		try {
			text = await Bun.file(configPath).text();
		} catch {
			text = "";
		}

		const doc = text.trim().length === 0 ? parseDocument(`${CONFIG_HEADER}\n`) : parseDocument(text);
		// Surface YAML parse errors as a thrown, not silently dropped, so an
		// invalid config.yml can't be silently rewritten.
		if (doc.errors.length > 0) {
			const message = doc.errors[0]?.message ?? "YAML parse error";
			throw new Error(`Cannot edit ${configPath}: ${message}`);
		}

		for (const edit of edits) {
			applyEdit(doc, edit);
		}

		await Bun.write(configPath, doc.toString());
	});
}
