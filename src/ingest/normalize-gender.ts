// The label a live USTA profile prints ahead of the gender value — `Competition Category: MALE`.
// `src/parsers/usta/profile.ts` already strips this at parse time (issue #130), but this function
// strips it too: it is the one place `archived.ts`, `player-pull.ts`, and the WTN profile route
// (`src/ingest/wtn-profile-pull.ts`) all write `players.gender` through, and it is also what
// `src/db/gender-backfill.ts` runs over the 77 rows that already hold the raw labelled string from
// before the parser fix existed. Two defenses against the same historical value, on purpose.
const LABEL_PREFIX = /^competition category:\s*/i;

/**
 * Map any source's spelling of a player's gender onto the one vocabulary `players.gender` stores
 * — `"Male"` or `"Female"` — or `null` for anything that is not exactly one of those, spelled out
 * in full (case-insensitively) and with the known USTA label optionally stripped.
 *
 * **Fails closed.** `null` covers every unrecognised input, not just the empty ones: `"Mixed"`,
 * `"M"`, `"F"`, and any future source's label — not only today's `"Competition Category:"` — all
 * return `null` rather than the raw string. This is the deliberate difference from the two
 * writers that predated it (`src/ingest/archived.ts` stored `usta.gender` RAW, verbatim, label and
 * all): storing null on drift means a re-run of the backfill (`src/db/gender-backfill.ts`) can
 * always recover the column later, once the new spelling is taught to this one function; storing
 * an unrecognised raw string means it is silently indistinguishable from an already-normalized
 * value forever after.
 *
 * This is the "ingest decision, made once where both sources meet, not twice inside two parsers"
 * that `src/parsers/usta/profile.ts`'s doc comment describes and that issue #130 found had never
 * actually been built — `players.gender` had two writers (`archived.ts`, `player-pull.ts`) that
 * disagreed about what belonged in the column, and neither routed through anything like this.
 *
 * Idempotent by construction: every value this function can return (`"Male"`, `"Female"`, `null`)
 * normalizes to itself, so re-running it — as the backfill does — is always safe.
 */
export function normalizeGender(raw: string | null | undefined): "Male" | "Female" | null {
  if (raw === null || raw === undefined) return null;

  const stripped = raw.replace(LABEL_PREFIX, "").trim();
  const upper = stripped.toUpperCase();

  if (upper === "MALE") return "Male";
  if (upper === "FEMALE") return "Female";
  return null;
}
