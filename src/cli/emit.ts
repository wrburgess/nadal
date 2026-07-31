import { sanitizeValue } from "../sanitize.js";
import { quoteSummaryValue } from "./summary.js";

/**
 * `--quiet`/`-q` and `--json` are advertised in `helpText()` (src/cli/router.ts) as global flags —
 * this is what makes that true. `quiet` suppresses stdout only: the exit code and anything written
 * to stderr (errors, warnings) are untouched, so a caller piping stdout to /dev/null still gets a
 * meaningful exit code. `json` swaps the human summary line for `JSON.stringify` of the same
 * fields. Passing both: `quiet` wins (checked first below) — GRAMMAR.md states this explicitly so
 * a caller composing both flags does not have to guess which one takes priority.
 */
export type EmitOpts = {
  quiet?: boolean;
  json?: boolean;
};

/**
 * `status` is always the first field and always one of a small, code-controlled set (`ok`,
 * `error`, `partial`, ...) — never attacker-influenced free text — so it is rendered bare
 * (`status=ok`) rather than quoted, matching every summary line every command has ever printed.
 * Every other field's value is either a `number` (a count — also code-controlled, rendered bare:
 * `roster=18`) or a `string` (a name, path, or message that MAY contain attacker-influenced text —
 * quoted via `quoteSummaryValue` so an embedded space, `=`, quote, or control character can't be
 * mistaken for a field boundary or corrupt the line).
 */
export type SummaryField = [string, string | number];

/**
 * The single writer of the deterministic one-line `key=value` CLI summary, shared by every command
 * instead of each hand-rolling its own `summarize()` (as `team pull` and `player pull` did before
 * this existed). Centralizing here is what makes `--quiet`/`--json` real for every command at
 * once — a command that calls this only ever has to build its `fields`, never re-implement quoting
 * or global-flag handling.
 *
 * `status === "ok"` writes to stdout; any other status (`error`, `partial`, ...) writes to stderr —
 * matching every command's existing behavior (a success line on stdout, everything else on
 * stderr) without asking each caller to also say which stream it wants, which would just restate
 * information the status already carries. `--quiet` suppresses ONLY the stdout line: GRAMMAR.md's
 * contract is "exit code and stderr unchanged", so a caller piping stdout to /dev/null must still
 * see (and be able to parse, under `--json`) a diagnostic on failure.
 */
/**
 * `JSON.stringify` of a whole result object, with every string leaf sanitized first.
 *
 * `emitSummary` below has sanitized its `--json` payload since PR A, but the three commands that
 * dump an entire profile object (`team show`, `player show`, `lineup plan`) called
 * `JSON.stringify` directly and bypassed it. That is a real gap, not a stylistic one:
 * `JSON.stringify` escapes the C0 controls but leaves category-Cf characters — notably
 * RIGHT-TO-LEFT OVERRIDE (U+202E) — and U+2028/U+2029 completely intact, so a scraped player name
 * carrying a bidi override reaches the terminal unchanged and can visually reorder the output a
 * human is reading. Found by the independent Codex review of PR #47 (rated medium), against the
 * new `lineup plan --json`; the two older commands had it too and go through here as well.
 *
 * Yes, this modifies data a machine consumer receives. That trade was already made deliberately for
 * the summary-line payload below, and it is the right one here for the same reason: these are
 * display names, the identifiers (`playerId`, `teamId`) travel in their own fields untouched, and a
 * character that cannot be rendered safely has no business being echoed to a terminal to protect a
 * fidelity nobody is relying on.
 *
 * Keys are sanitized as well as values — every key here is code-authored today, so this cannot
 * currently matter, but a hostile key would spoof exactly as well as a hostile value and the guard
 * costs nothing.
 */
export function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeValue(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeValue(k), sanitizeJson(v)]));
  }
  return value;
}

/** `JSON.stringify` with every string leaf sanitized — the only spelling a CLI command should use
 * to emit a whole object under `--json`. */
export function emitJson(value: unknown): string {
  return JSON.stringify(sanitizeJson(value));
}

export function emitSummary(command: string, status: string, fields: SummaryField[], opts: EmitOpts = {}): void {
  const toStderr = status !== "ok";
  if (opts.quiet && !toStderr) return;
  const write = toStderr ? console.error : console.log;

  if (opts.json) {
    const payload: Record<string, string | number> = { status };
    for (const [key, value] of fields) {
      payload[key] = typeof value === "number" ? value : sanitizeValue(value);
    }
    write(JSON.stringify(payload));
    return;
  }

  const rendered = fields.map(
    ([key, value]) => `${key}=${typeof value === "number" ? String(value) : `"${quoteSummaryValue(value)}"`}`,
  );
  write([`${command} status=${status}`, ...rendered].join(" "));
}
