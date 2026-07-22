//! jsdiff-compatible diff primitives.
//!
//! # Overview
//! Line, line-array, and word diffs plus a unified-patch hunk builder, all
//! producing byte-identical output to the `diff` npm package (jsdiff v9) under
//! its default options. The Myers O(ND) core is a faithful port of jsdiff's
//! `base.ts`, including its greedy tie-breaking and the edit-graph edge pruning
//! (`minDiagonalToConsider` / `maxDiagonalToConsider`), so change coalescing
//! matches jsdiff run-for-run rather than merely being "a" minimal diff.
//!
//! # Example
//! ```ignore
//! // JS: native.diffLines("a\nb\n", "a\nc\n")
//! //   -> [{ value: "a\n", count: 1, added: false, removed: false },
//! //       { value: "b\n", count: 1, added: false, removed: true },
//! //       { value: "c\n", count: 1, added: true, removed: false }]
//! ```

use std::{collections::HashMap, rc::Rc};

use napi_derive::napi;

/// One jsdiff change object: a run of added, removed, or common tokens.
#[napi(object)]
pub struct DiffChange {
	/// Joined token text for this run (lines keep their `\n` terminators).
	pub value:   String,
	/// Number of tokens in this run.
	pub count:   u32,
	/// True when this run exists only in the new text.
	pub added:   bool,
	/// True when this run exists only in the old text.
	pub removed: bool,
}

/// A change run without its token text, for callers that only need counts.
#[napi(object)]
pub struct DiffRun {
	/// Number of tokens in this run.
	pub count:   u32,
	/// True when this run exists only in the new text.
	pub added:   bool,
	/// True when this run exists only in the old text.
	pub removed: bool,
}

/// One hunk of a unified diff, matching jsdiff `structuredPatch` hunks.
#[napi(object)]
pub struct PatchHunk {
	/// 1-based first line of the hunk in the old text.
	pub old_start: u32,
	/// Number of old-text lines covered by the hunk.
	pub old_lines: u32,
	/// 1-based first line of the hunk in the new text.
	pub new_start: u32,
	/// Number of new-text lines covered by the hunk.
	pub new_lines: u32,
	/// Hunk body: `+`/`-`/` `-prefixed lines without trailing newlines, plus
	/// `\ No newline at end of file` markers where applicable.
	pub lines:     Vec<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// Myers core (port of jsdiff base.ts, default options)
// ═══════════════════════════════════════════════════════════════════════════

/// A run of tokens sharing one edit classification, in forward order.
#[derive(Clone, Copy)]
struct Run {
	count:   usize,
	added:   bool,
	removed: bool,
}

/// Reverse-linked component list node, shared between diagonal paths exactly
/// like jsdiff's `previousComponent` chains (structural sharing keeps the
/// D-path frontier O(D) instead of O(D^2)).
struct Component {
	count:   usize,
	added:   bool,
	removed: bool,
	prev:    Option<Rc<Self>>,
}

/// Frontier state for one diagonal: furthest old-position reached plus the
/// component chain that got there.
struct PathState {
	old_pos: isize,
	last:    Option<Rc<Component>>,
}

/// Extend `path` along its diagonal while tokens match, recording the common
/// run. Returns the new-token position (mirrors jsdiff `extractCommon`).
fn extract_common(path: &mut PathState, new: &[u32], old: &[u32], diagonal: isize) -> isize {
	let new_len = new.len() as isize;
	let old_len = old.len() as isize;
	let mut old_pos = path.old_pos;
	let mut new_pos = old_pos - diagonal;
	let mut common = 0usize;
	while new_pos + 1 < new_len
		&& old_pos + 1 < old_len
		&& old[(old_pos + 1) as usize] == new[(new_pos + 1) as usize]
	{
		new_pos += 1;
		old_pos += 1;
		common += 1;
	}
	if common > 0 {
		path.last = Some(Rc::new(Component {
			count:   common,
			added:   false,
			removed: false,
			prev:    path.last.take(),
		}));
	}
	path.old_pos = old_pos;
	new_pos
}

/// Branch from `path` with one added or removed token (mirrors jsdiff
/// `addToPath`, which merges into the previous component when the edit kind
/// repeats).
fn add_to_path(path: &PathState, added: bool, removed: bool, old_pos_inc: isize) -> PathState {
	match &path.last {
		Some(last) if last.added == added && last.removed == removed => PathState {
			old_pos: path.old_pos + old_pos_inc,
			last:    Some(Rc::new(Component {
				count: last.count + 1,
				added,
				removed,
				prev: last.prev.clone(),
			})),
		},
		_ => PathState {
			old_pos: path.old_pos + old_pos_inc,
			last:    Some(Rc::new(Component { count: 1, added, removed, prev: path.last.clone() })),
		},
	}
}

/// Convert the winning component chain into forward-ordered runs.
fn build_runs(last: Option<Rc<Component>>) -> Vec<Run> {
	let mut runs = Vec::new();
	let mut cursor = last.as_deref();
	while let Some(component) = cursor {
		runs.push(Run {
			count:   component.count,
			added:   component.added,
			removed: component.removed,
		});
		cursor = component.prev.as_deref();
	}
	runs.reverse();
	runs
}

/// Myers O(ND) diff over interned token ids, replicating jsdiff's default
/// (non-`oneChangePerToken`, no timeout / `maxEditLength`) execution path so
/// the resulting run structure is identical.
fn myers_diff(old: &[u32], new: &[u32]) -> Vec<Run> {
	let old_len = old.len() as isize;
	let new_len = new.len() as isize;
	let max_edit = old_len + new_len;
	let offset = max_edit + 1;
	let mut best: Vec<Option<PathState>> = Vec::new();
	best.resize_with((2 * max_edit + 3) as usize, || None);

	// Seed edit length 0: the content may start with common tokens.
	let mut seed = PathState { old_pos: -1, last: None };
	let seed_new_pos = extract_common(&mut seed, new, old, 0);
	if seed.old_pos + 1 >= old_len && seed_new_pos + 1 >= new_len {
		return build_runs(seed.last);
	}
	best[offset as usize] = Some(seed);

	let mut min_diagonal = isize::MIN;
	let mut max_diagonal = isize::MAX;
	let mut edit_length: isize = 1;
	while edit_length <= max_edit {
		let mut diagonal = min_diagonal.max(-edit_length);
		while diagonal <= max_diagonal.min(edit_length) {
			let idx = (diagonal + offset) as usize;
			let remove_path = best[idx - 1].take();
			let add_path_old_pos = best[idx + 1].as_ref().map(|path| path.old_pos);
			let can_add = add_path_old_pos.is_some_and(|old_pos| {
				let add_new_pos = old_pos - diagonal;
				add_new_pos >= 0 && add_new_pos < new_len
			});
			let can_remove = remove_path
				.as_ref()
				.is_some_and(|path| path.old_pos + 1 < old_len);
			if !can_add && !can_remove {
				best[idx] = None;
				diagonal += 2;
				continue;
			}

			// Branch from the prior path whose old-text position is furthest
			// along, preferring the insertion path on ties (jsdiff order).
			let mut base_path = if !can_remove
				|| (can_add
					&& remove_path.as_ref().is_some_and(|path| {
						add_path_old_pos.is_some_and(|add_old| path.old_pos < add_old)
					})) {
				add_to_path(
					best[idx + 1]
						.as_ref()
						.expect("canAdd implies a live addPath"),
					true,
					false,
					0,
				)
			} else {
				add_to_path(
					remove_path
						.as_ref()
						.expect("canRemove implies a live removePath"),
					false,
					true,
					1,
				)
			};
			let new_pos = extract_common(&mut base_path, new, old, diagonal);
			if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
				return build_runs(base_path.last);
			}
			if base_path.old_pos + 1 >= old_len {
				max_diagonal = max_diagonal.min(diagonal - 1);
			}
			if new_pos + 1 >= new_len {
				min_diagonal = min_diagonal.max(diagonal + 1);
			}
			best[idx] = Some(base_path);
			diagonal += 2;
		}
		edit_length += 1;
	}
	unreachable!("Myers diff terminates within oldLen + newLen edits")
}

/// Intern each token as a dense id under exact string equality, so the Myers
/// core compares `u32`s instead of re-hashing strings per probe.
fn intern_exact<'a>(old_tokens: &[&'a str], new_tokens: &[&'a str]) -> (Vec<u32>, Vec<u32>) {
	fn assign<'a>(ids: &mut HashMap<&'a str, u32>, token: &'a str) -> u32 {
		let next = ids.len() as u32;
		*ids.entry(token).or_insert(next)
	}
	let mut ids: HashMap<&'a str, u32> = HashMap::with_capacity(old_tokens.len() + new_tokens.len());
	let old_ids = old_tokens
		.iter()
		.map(|token| assign(&mut ids, token))
		.collect();
	let new_ids = new_tokens
		.iter()
		.map(|token| assign(&mut ids, token))
		.collect();
	(old_ids, new_ids)
}

/// Map runs back to change objects, joining token slices with `join`.
/// Common runs take their text from the new tokens, matching jsdiff
/// `buildValues` with `useLongestToken == false`.
fn build_changes(
	runs: &[Run],
	old_tokens: &[&str],
	new_tokens: &[&str],
	join: impl Fn(&[&str]) -> String,
) -> Vec<DiffChange> {
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	runs
		.iter()
		.map(|run| {
			let value = if run.removed {
				let value = join(&old_tokens[old_pos..old_pos + run.count]);
				old_pos += run.count;
				value
			} else {
				let value = join(&new_tokens[new_pos..new_pos + run.count]);
				new_pos += run.count;
				if !run.added {
					old_pos += run.count;
				}
				value
			};
			DiffChange { value, count: run.count as u32, added: run.added, removed: run.removed }
		})
		.collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// Line diff
// ═══════════════════════════════════════════════════════════════════════════

/// jsdiff line tokenization under default options: each token is a line
/// including its `\n` (or `\r\n`) terminator; a final line without a newline
/// is kept as-is; a lone `\r` never terminates a line.
fn line_tokens(text: &str) -> Vec<&str> {
	text.split_inclusive('\n').collect()
}

fn diff_line_tokens<'a>(old_tokens: &[&'a str], new_tokens: &[&'a str]) -> Vec<Run> {
	let (old_ids, new_ids) = intern_exact(old_tokens, new_tokens);
	myers_diff(&old_ids, &new_ids)
}

/// Line diff with jsdiff `diffLines(oldText, newText)` semantics (default
/// options). Change values keep line terminators, and common runs are joined
/// from the new text.
#[napi]
pub fn diff_lines(old_text: String, new_text: String) -> Vec<DiffChange> {
	let old_tokens = line_tokens(&old_text);
	let new_tokens = line_tokens(&new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	build_changes(&runs, &old_tokens, &new_tokens, |tokens| tokens.concat())
}

/// Diff `oldText.split("\n")` against `newText.split("\n")` with jsdiff
/// `diffArrays` semantics (exact string equality, empty lines preserved),
/// returning only run lengths.
///
/// Callers that map line numbers — like hashline recovery — need the counts,
/// not another copy of the text.
#[napi]
pub fn diff_line_runs(old_text: String, new_text: String) -> Vec<DiffRun> {
	let old_tokens: Vec<&str> = old_text.split('\n').collect();
	let new_tokens: Vec<&str> = new_text.split('\n').collect();
	let (old_ids, new_ids) = intern_exact(&old_tokens, &new_tokens);
	myers_diff(&old_ids, &new_ids)
		.into_iter()
		.map(|run| DiffRun { count: run.count as u32, added: run.added, removed: run.removed })
		.collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// Structured patch (port of jsdiff patch/create.ts hunk builder)
// ═══════════════════════════════════════════════════════════════════════════

/// Unified-diff hunks with jsdiff
/// `structuredPatch(_, _, oldText, newText, _, _, { context }).hunks`
/// semantics. `context` defaults to 4 like jsdiff.
#[napi]
pub fn structured_patch_hunks(
	old_text: String,
	new_text: String,
	context: Option<u32>,
) -> Vec<PatchHunk> {
	let context = context.map_or(4usize, |value| value as usize);
	let old_tokens = line_tokens(&old_text);
	let new_tokens = line_tokens(&new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);

	// Change list with per-change line slices; the trailing sentinel mirrors
	// jsdiff's pushed empty change that flushes the final hunk.
	struct ChangeLines<'a> {
		added:   bool,
		removed: bool,
		lines:   &'a [&'a str],
	}
	let mut list: Vec<ChangeLines> = Vec::with_capacity(runs.len() + 1);
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	for run in &runs {
		let lines: &[&str] = if run.removed {
			let slice = &old_tokens[old_pos..old_pos + run.count];
			old_pos += run.count;
			slice
		} else {
			let slice = &new_tokens[new_pos..new_pos + run.count];
			new_pos += run.count;
			if !run.added {
				old_pos += run.count;
			}
			slice
		};
		list.push(ChangeLines { added: run.added, removed: run.removed, lines });
	}
	list.push(ChangeLines { added: false, removed: false, lines: &[] });

	let mut hunks: Vec<PatchHunk> = Vec::new();
	let mut old_range_start = 0usize;
	let mut new_range_start = 0usize;
	let mut cur_range: Vec<String> = Vec::new();
	let mut old_line = 1usize;
	let mut new_line = 1usize;
	for i in 0..list.len() {
		let current = &list[i];
		if current.added || current.removed {
			// Open a hunk seeded with trailing context from the previous
			// common run.
			if old_range_start == 0 {
				old_range_start = old_line;
				new_range_start = new_line;
				if i > 0 && context > 0 {
					let prev_lines = list[i - 1].lines;
					let take = prev_lines.len().min(context);
					cur_range = prev_lines[prev_lines.len() - take..]
						.iter()
						.map(|line| format!(" {line}"))
						.collect();
					old_range_start -= cur_range.len();
					new_range_start -= cur_range.len();
				}
			}
			let marker = if current.added { '+' } else { '-' };
			for line in current.lines {
				cur_range.push(format!("{marker}{line}"));
			}
			if current.added {
				new_line += current.lines.len();
			} else {
				old_line += current.lines.len();
			}
		} else {
			if old_range_start != 0 {
				if current.lines.len() <= context * 2 && i + 2 < list.len() {
					// Common run small enough to join adjacent hunks.
					for line in current.lines {
						cur_range.push(format!(" {line}"));
					}
				} else {
					// Close the hunk with leading context.
					let context_size = current.lines.len().min(context);
					for line in &current.lines[..context_size] {
						cur_range.push(format!(" {line}"));
					}
					hunks.push(PatchHunk {
						old_start: old_range_start as u32,
						old_lines: (old_line - old_range_start + context_size) as u32,
						new_start: new_range_start as u32,
						new_lines: (new_line - new_range_start + context_size) as u32,
						lines:     std::mem::take(&mut cur_range),
					});
					old_range_start = 0;
					new_range_start = 0;
				}
			}
			old_line += current.lines.len();
			new_line += current.lines.len();
		}
	}

	// Strip trailing newlines and add "no newline at EOF" markers.
	for hunk in &mut hunks {
		let mut i = 0;
		while i < hunk.lines.len() {
			if hunk.lines[i].ends_with('\n') {
				hunk.lines[i].pop();
			} else {
				hunk
					.lines
					.insert(i + 1, "\\ No newline at end of file".to_string());
				i += 1;
			}
			i += 1;
		}
	}
	hunks
}

// ═══════════════════════════════════════════════════════════════════════════
// Word diff (port of jsdiff word.ts, default options)
// ═══════════════════════════════════════════════════════════════════════════

/// jsdiff's `extendedWordChars` class: Latin-script word characters.
const fn is_word_char(c: char) -> bool {
	matches!(c,
		'a'..='z'
		| 'A'..='Z'
		| '0'..='9'
		| '_'
		| '\u{ad}'
		| '\u{c0}'..='\u{d6}'
		| '\u{d8}'..='\u{f6}'
		| '\u{f8}'..='\u{2c6}'
		| '\u{2c8}'..='\u{2d7}'
		| '\u{2de}'..='\u{2ff}'
		| '\u{1e00}'..='\u{1eff}')
}

/// JavaScript's `\s` / `String.prototype.trim` whitespace set (`WhiteSpace` +
/// `LineTerminator` productions). Every member is a single UTF-16 code unit, so
/// char-level scans here match jsdiff's code-unit-level scans exactly.
const fn is_js_whitespace(c: char) -> bool {
	matches!(
		c,
		'\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
			..='\u{200a}'
				| '\u{2028}'
				| '\u{2029}'
				| '\u{202f}'
				| '\u{205f}'
				| '\u{3000}'
				| '\u{feff}'
	)
}

fn leading_ws(s: &str) -> &str {
	&s[..s.len() - s.trim_start_matches(is_js_whitespace).len()]
}

fn trailing_ws(s: &str) -> &str {
	&s[s.trim_end_matches(is_js_whitespace).len()..]
}

fn js_trim(s: &str) -> &str {
	s.trim_matches(is_js_whitespace)
}

/// Raw regex-equivalent scan: word runs, whitespace runs, or single other
/// code points (jsdiff `tokenizeIncludingWhitespace` with the `u` flag).
fn word_parts(text: &str) -> Vec<&str> {
	let mut parts = Vec::new();
	let mut iter = text.char_indices().peekable();
	while let Some((start, c)) = iter.next() {
		let class = if is_word_char(c) {
			1u8
		} else if is_js_whitespace(c) {
			2u8
		} else {
			0u8
		};
		let mut end = start + c.len_utf8();
		if class != 0 {
			while let Some(&(next_start, next)) = iter.peek() {
				let same = if class == 1 {
					is_word_char(next)
				} else {
					is_js_whitespace(next)
				};
				if !same {
					break;
				}
				end = next_start + next.len_utf8();
				iter.next();
			}
		}
		parts.push(&text[start..end]);
	}
	parts
}

/// jsdiff `WordDiff.tokenize`: stitch whitespace runs onto adjacent word or
/// punctuation parts, duplicating interior whitespace into both neighbors.
fn word_tokens(text: &str) -> Vec<String> {
	let parts = word_parts(text);
	let mut tokens: Vec<String> = Vec::with_capacity(parts.len());
	let mut prev_part: Option<&str> = None;
	for part in parts {
		let part_is_ws = part.chars().next().is_some_and(is_js_whitespace);
		if part_is_ws {
			if prev_part.is_none() {
				tokens.push(part.to_string());
			} else {
				let last = tokens
					.last_mut()
					.expect("tokens non-empty after first part");
				last.push_str(part);
			}
		} else if let Some(prev) =
			prev_part.filter(|p| p.chars().next().is_some_and(is_js_whitespace))
		{
			if tokens.last().is_some_and(|last| last == prev) {
				let last = tokens.last_mut().expect("checked non-empty");
				last.push_str(part);
			} else {
				tokens.push(format!("{prev}{part}"));
			}
		} else {
			tokens.push(part.to_string());
		}
		prev_part = Some(part);
	}
	tokens
}

/// jsdiff `WordDiff.join`: concatenate, stripping leading whitespace from
/// every token after the first.
fn word_join(tokens: &[&str]) -> String {
	let mut out = String::new();
	for (i, token) in tokens.iter().enumerate() {
		if i == 0 {
			out.push_str(token);
		} else {
			out.push_str(token.trim_start_matches(is_js_whitespace));
		}
	}
	out
}

fn longest_common_prefix<'a>(a: &'a str, b: &str) -> &'a str {
	let mut end = 0;
	for (ca, cb) in a.chars().zip(b.chars()) {
		if ca != cb {
			break;
		}
		end += ca.len_utf8();
	}
	&a[..end]
}

fn longest_common_suffix<'a>(a: &'a str, b: &str) -> &'a str {
	let mut start = a.len();
	for (ca, cb) in a.chars().rev().zip(b.chars().rev()) {
		if ca != cb {
			break;
		}
		start -= ca.len_utf8();
	}
	&a[start..]
}

fn remove_prefix(s: &str, prefix: &str) -> String {
	s.strip_prefix(prefix)
		.expect("value must start with recorded prefix")
		.to_string()
}

fn remove_suffix(s: &str, suffix: &str) -> String {
	s.strip_suffix(suffix)
		.expect("value must end with recorded suffix")
		.to_string()
}

fn replace_prefix(s: &str, old_prefix: &str, new_prefix: &str) -> String {
	let rest = s
		.strip_prefix(old_prefix)
		.expect("value must start with recorded prefix");
	format!("{new_prefix}{rest}")
}

fn replace_suffix(s: &str, old_suffix: &str, new_suffix: &str) -> String {
	let rest = s
		.strip_suffix(old_suffix)
		.expect("value must end with recorded suffix");
	format!("{rest}{new_suffix}")
}

/// jsdiff `maximumOverlap`: the longest prefix of `b` that is also a suffix
/// of `a`, via the KMP failure function.
fn maximum_overlap<'a>(a: &str, b: &'a str) -> &'a str {
	let a_chars: Vec<char> = a.chars().collect();
	let b_chars: Vec<char> = b.chars().collect();
	let start_a = a_chars.len().saturating_sub(b_chars.len());
	let end_b = b_chars.len().min(a_chars.len());
	if end_b == 0 {
		return "";
	}
	let mut map = vec![0usize; end_b];
	let mut k = 0usize;
	for j in 1..end_b {
		if b_chars[j] == b_chars[k] {
			map[j] = map[k];
		} else {
			map[j] = k;
		}
		while k > 0 && b_chars[j] != b_chars[k] {
			k = map[k];
		}
		if b_chars[j] == b_chars[k] {
			k += 1;
		}
	}
	k = 0;
	for &c in &a_chars[start_a..] {
		while k > 0 && c != b_chars[k] {
			k = map[k];
		}
		if c == b_chars[k] {
			k += 1;
		}
	}
	let byte_end: usize = b_chars[..k].iter().map(|c| c.len_utf8()).sum();
	&b[..byte_end]
}

/// jsdiff `dedupeWhitespaceInChangeObjects` (no segmenter): trim whitespace
/// that the tokenizer duplicated across a keep/delete/insert boundary.
fn dedupe_whitespace(
	changes: &mut [DiffChange],
	start_keep: Option<usize>,
	deletion: Option<usize>,
	insertion: Option<usize>,
	end_keep: Option<usize>,
) {
	match (deletion, insertion) {
		(Some(del), Some(ins)) => {
			let old_ws_prefix = leading_ws(&changes[del].value).to_string();
			let old_ws_suffix = trailing_ws(&changes[del].value).to_string();
			let new_ws_prefix = leading_ws(&changes[ins].value).to_string();
			let new_ws_suffix = trailing_ws(&changes[ins].value).to_string();
			if let Some(start) = start_keep {
				let common_ws_prefix =
					longest_common_prefix(&old_ws_prefix, &new_ws_prefix).to_string();
				changes[start].value =
					replace_suffix(&changes[start].value, &new_ws_prefix, &common_ws_prefix);
				changes[del].value = remove_prefix(&changes[del].value, &common_ws_prefix);
				changes[ins].value = remove_prefix(&changes[ins].value, &common_ws_prefix);
			}
			if let Some(end) = end_keep {
				let common_ws_suffix =
					longest_common_suffix(&old_ws_suffix, &new_ws_suffix).to_string();
				changes[end].value =
					replace_prefix(&changes[end].value, &new_ws_suffix, &common_ws_suffix);
				changes[del].value = remove_suffix(&changes[del].value, &common_ws_suffix);
				changes[ins].value = remove_suffix(&changes[ins].value, &common_ws_suffix);
			}
		},
		(None, Some(ins)) => {
			if start_keep.is_some() {
				let ws = leading_ws(&changes[ins].value).to_string();
				changes[ins].value = changes[ins].value[ws.len()..].to_string();
			}
			if let Some(end) = end_keep {
				let ws = leading_ws(&changes[end].value).to_string();
				changes[end].value = changes[end].value[ws.len()..].to_string();
			}
		},
		(Some(del), None) => match (start_keep, end_keep) {
			(Some(start), Some(end)) => {
				let new_ws_full = leading_ws(&changes[end].value).to_string();
				let del_ws_start = leading_ws(&changes[del].value).to_string();
				let del_ws_end = trailing_ws(&changes[del].value).to_string();
				let new_ws_start = longest_common_prefix(&new_ws_full, &del_ws_start).to_string();
				changes[del].value = remove_prefix(&changes[del].value, &new_ws_start);
				let new_ws_end =
					longest_common_suffix(&new_ws_full[new_ws_start.len()..], &del_ws_end).to_string();
				changes[del].value = remove_suffix(&changes[del].value, &new_ws_end);
				changes[end].value = replace_prefix(&changes[end].value, &new_ws_full, &new_ws_end);
				let start_ws = &new_ws_full[..new_ws_full.len() - new_ws_end.len()];
				changes[start].value = replace_suffix(&changes[start].value, &new_ws_full, start_ws);
			},
			(None, Some(end)) => {
				let end_keep_ws_prefix = leading_ws(&changes[end].value).to_string();
				let deletion_ws_suffix = trailing_ws(&changes[del].value).to_string();
				let overlap = maximum_overlap(&deletion_ws_suffix, &end_keep_ws_prefix).to_string();
				changes[del].value = remove_suffix(&changes[del].value, &overlap);
			},
			(Some(start), None) => {
				let start_keep_ws_suffix = trailing_ws(&changes[start].value).to_string();
				let deletion_ws_prefix = leading_ws(&changes[del].value).to_string();
				let overlap = maximum_overlap(&start_keep_ws_suffix, &deletion_ws_prefix).to_string();
				changes[del].value = remove_prefix(&changes[del].value, &overlap);
			},
			(None, None) => {},
		},
		(None, None) => {},
	}
}

/// jsdiff `WordDiff.postProcess` under default options.
fn word_post_process(changes: &mut [DiffChange]) {
	let mut last_keep: Option<usize> = None;
	let mut insertion: Option<usize> = None;
	let mut deletion: Option<usize> = None;
	for i in 0..changes.len() {
		if changes[i].added {
			insertion = Some(i);
		} else if changes[i].removed {
			deletion = Some(i);
		} else {
			if insertion.is_some() || deletion.is_some() {
				dedupe_whitespace(changes, last_keep, deletion, insertion, Some(i));
			}
			last_keep = Some(i);
			insertion = None;
			deletion = None;
		}
	}
	if insertion.is_some() || deletion.is_some() {
		dedupe_whitespace(changes, last_keep, deletion, insertion, None);
	}
}

/// Word diff with jsdiff `diffWords(oldText, newText)` semantics (default
/// options).
///
/// Tokens carry surrounding whitespace, equality ignores it, and the
/// post-pass dedupes whitespace across change boundaries.
#[napi]
pub fn diff_words(old_text: String, new_text: String) -> Vec<DiffChange> {
	let old_tokens = word_tokens(&old_text);
	let new_tokens = word_tokens(&new_text);
	let old_refs: Vec<&str> = old_tokens.iter().map(String::as_str).collect();
	let new_refs: Vec<&str> = new_tokens.iter().map(String::as_str).collect();
	// Equality is whitespace-insensitive: intern by trimmed text.
	let old_keys: Vec<&str> = old_refs.iter().map(|token| js_trim(token)).collect();
	let new_keys: Vec<&str> = new_refs.iter().map(|token| js_trim(token)).collect();
	let (old_ids, new_ids) = intern_exact(&old_keys, &new_keys);
	let runs = myers_diff(&old_ids, &new_ids);
	let mut changes = build_changes(&runs, &old_refs, &new_refs, word_join);
	word_post_process(&mut changes);
	changes
}

#[cfg(test)]
mod tests {
	use super::*;

	fn lines(old: &str, new: &str) -> Vec<(String, bool, bool)> {
		diff_lines(old.to_string(), new.to_string())
			.into_iter()
			.map(|c| (c.value, c.added, c.removed))
			.collect()
	}

	#[test]
	fn line_diff_replaces_middle_line() {
		assert_eq!(lines("a\nb\nc\n", "a\nx\nc\n"), vec![
			("a\n".into(), false, false),
			("b\n".into(), false, true),
			("x\n".into(), true, false),
			("c\n".into(), false, false),
		]);
	}

	#[test]
	fn line_diff_treats_missing_trailing_newline_as_distinct() {
		assert_eq!(lines("a\nb", "a\nb\n"), vec![
			("a\n".into(), false, false),
			("b".into(), false, true),
			("b\n".into(), true, false),
		]);
	}

	#[test]
	fn structured_patch_marks_missing_eof_newline() {
		let hunks = structured_patch_hunks("a\nb".into(), "a\nc".into(), Some(3));
		assert_eq!(hunks.len(), 1);
		assert_eq!(hunks[0].lines, vec![
			" a",
			"-b",
			"\\ No newline at end of file",
			"+c",
			"\\ No newline at end of file"
		]);
	}

	#[test]
	fn word_diff_dedupes_boundary_whitespace() {
		// jsdiff's documented example 2: K:'foo ' D:'bar' I:'qux' K:' baz'.
		let changes = diff_words("foo bar baz".into(), "foo qux baz".into());
		let shaped: Vec<(String, bool, bool)> = changes
			.into_iter()
			.map(|c| (c.value, c.added, c.removed))
			.collect();
		assert_eq!(shaped, vec![
			("foo ".into(), false, false),
			("bar".into(), false, true),
			("qux".into(), true, false),
			(" baz".into(), false, false),
		]);
	}

	#[test]
	fn line_runs_preserve_empty_lines() {
		let runs = diff_line_runs("a\n\nb".into(), "a\n\nc".into());
		let shaped: Vec<(u32, bool, bool)> = runs
			.into_iter()
			.map(|r| (r.count, r.added, r.removed))
			.collect();
		assert_eq!(shaped, vec![(2, false, false), (1, false, true), (1, true, false)]);
	}
}
