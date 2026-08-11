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
 * **Fails closed on the WRITE path.** `null` covers every unrecognised input, not just the empty
 * ones: `"Mixed"`, `"M"`, `"F"`, and any future source's label — not only today's
 * `"Competition Category:"` — all return `null` rather than the raw string. This is the deliberate
 * difference from the two writers that predated it (`src/ingest/archived.ts` stored `usta.gender`
 * RAW, verbatim, label and all): an unrecognised raw string in the column is silently
 * indistinguishable from an already-normalized value forever after, which is the shape of #130.
 *
 * **That is a rule about what may ENTER the column, not a licence to destroy what is already in
 * it.** `src/db/gender-backfill.ts` deliberately does NOT null a stored value this function cannot
 * map — it leaves it exactly as it is — because a legitimate-but-unmapped spelling on disk is a
 * source fact nobody has taught us yet, and nulling it discards it permanently. An earlier version
 * of this comment claimed a nulled row could "always be recovered later by re-running the
 * backfill"; that was false, because the backfill only ever selects `WHERE gender IS NOT NULL`, so
 * a row it had nulled was never revisited. The claim is dropped and the backfill is the thing that
 * changed to make recovery real. (Codex adversarial review round 1, PR #138.)
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
