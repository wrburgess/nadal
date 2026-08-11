import { readFileSync } from "node:fs";
import type { players } from "../db/schema.js";
import { errorMessage } from "../error-message.js";
import { ParseError, parseWtnProfile } from "../parsers/index.js";
import { archivePage } from "./archive.js";
import type { Db } from "./db-types.js";
import { AmbiguousIdentityError, type AmbiguousIdentity } from "./errors.js";
import { resolvePlayer } from "./identity.js";
import { genderWrite } from "./normalize-gender.js";
import { slugFromUrl } from "./player-pull.js";
import { upsertPlayer } from "./upsert.js";

type PlayerRow = typeof players.$inferSelect;

export type ArchivedWtnProfilePullOptions = {
  db: Db;
  /** A local file the HC saved from worldtennisnumber.com — never fetched by this tool. */
  path: string;
  /** The real page URL, supplied by the HC since a saved file carries none of its own. Its own
   * `tennis-id` query parameter is the player identity `parseWtnProfile` reads (issue #128) — the
   * same role a USTA profile's `#uaid=` fragment plays for `pullArchivedUstaProfile`. */
  sourceUrl: string;
};

export type ArchivedWtnProfilePullResult =
  | { kind: "ok"; player: PlayerRow; archivedPath: string }
  | ({ kind: "ambiguous" } & AmbiguousIdentity)
  | { kind: "error"; message: string };

/**
 * The login-assisted ingestion path for a player's OWN WTN profile page (issue #128) — a
 * DIFFERENT page and a different fetch from the ITF widget USTA embeds inside its own profile
 * (`pullArchivedUstaProfile`, issue #132's rating source of record). Modeled on that function's
 * shape: archive first, parse the archived bytes (never the live network), resolve identity, and
 * report the same three-way `ok` / `ambiguous` / `error` outcome so every existing reporting
 * surface (`ambiguousMessage`, the CLI's `report()`) already knows how to render this one too.
 *
 * Only `ageRange` and normalized `gender` are written. `canonicalName` is deliberately left
 * UNTOUCHED on a matched player: this route's whole reason to exist is enrichment of a player
 * already on file (only 77-of-1745 players have a `wtn_tennis_id` at all, and every one of them
 * got it from a USTA/WTN capture that ran first), not a rename from this page's own spelling —
 * worldtennisnumber.com is not this project's source of truth for how a name is cased.
 * **This route accepts an ID-tier match only.** An earlier cut wrote `wtnTennisId` back
 * unconditionally, reasoning that a name-tier match should have the identity it just resolved made
 * durable. That reasoning is inverted: a name-tier match is precisely the case where the identity
 * is NOT established, and writing the id there is what makes a same-name mix-up permanent. See the
 * guard in the transaction below for the full argument.
 */
export async function pullArchivedWtnProfile(
  options: ArchivedWtnProfilePullOptions,
): Promise<ArchivedWtnProfilePullResult> {
  const { db, path, sourceUrl } = options;
  const body = readFileSync(path, "utf8");

  const archivedPath = archivePage({
    sourceSet: "wtn",
    slug: slugFromUrl(sourceUrl),
    url: sourceUrl,
    body,
    httpStatus: 200,
  });

  const source = { url: sourceUrl, fetchedAt: new Date().toISOString() };
  let profile;
  try {
    profile = parseWtnProfile(body, source);
  } catch (err) {
    if (err instanceof ParseError) return { kind: "error", message: err.message };
    throw err;
  }

  try {
    const player = db.transaction((tx) => {
      const resolved = resolvePlayer(tx, { wtnTennisId: profile.tennisId, name: profile.name });
      if (resolved.kind === "ambiguous") {
        // One identity, not a collected pass: this pull resolves exactly one name — the profile's
        // own — so there is never a second ambiguity for it to meet (same reasoning as
        // `pullArchivedUstaProfile`, contrast `pullPlayer`'s whole-history collect, #96).
        throw new AmbiguousIdentityError([
          {
            incoming: profile.name,
            candidates: resolved.candidates.map((p) => p.canonicalName),
            context: "archived WTN profile name",
          },
        ]);
      }
      // REQUIRE the id tier. `resolvePlayer` reports `matched` without saying which tier produced
      // it, and an id-tier hit on `wtnTennisId` is exactly the case where the resolved row ALREADY
      // carries this id — so comparing it here is a faithful test of "was this matched by identity
      // or by name?" without changing `resolvePlayer`'s contract.
      //
      // A name-tier match must be refused rather than written. Two people can share a name, and
      // this route would otherwise attach one person's ITF id, age range and gender PERMANENTLY to
      // the other: the write below sets `wtnTennisId`, after which every later pull for the real
      // owner resolves by id straight onto the wrong row, and `players_wtn_tennis_id_unique` then
      // blocks the right one from ever taking it. The repo has already ruled that identity is
      // decided by source evidence and never by name similarity.
      //
      // Refusing costs nothing real: `wtn_tennis_id` is written by the USTA capture, which always
      // runs first, so every player this route is meant to enrich already has one. A player who
      // does not is telling you the USTA pull has not happened yet, and that is the fix.
      // (Codex adversarial review round 1, PR #138, class A.)
      if (resolved.row.wtnTennisId !== profile.tennisId) {
        throw new Error(
          `refusing to write: the WTN profile for "${profile.name}" (${profile.tennisId}) resolved by ` +
            `NAME onto player ${resolved.row.id} ("${resolved.row.canonicalName}"), whose stored ITF id is ` +
            `${resolved.row.wtnTennisId === null ? "unset" : `"${resolved.row.wtnTennisId}"`}. Two people ` +
            `can share a name, so this route only accepts a match on the ITF id itself — run the USTA ` +
            `profile pull for this player first, which is what records the id.`,
        );
      }
      return upsertPlayer(tx, {
        id: resolved.row.id,
        wtnTennisId: profile.tennisId,
        ageRange: profile.ageRange,
        // The page prints "Male"/"Female" already — this project's own stored vocabulary — but the
        // write still routes through `normalizeGender` (issue #130) rather than trusting that: it
        // is the one place every writer of `players.gender` meets, and skipping a writer here is
        // exactly how the column ended up with two that disagreed in the first place.
        gender: genderWrite(profile.gender),
      });
    });

    return { kind: "ok", player, archivedPath };
  } catch (err) {
    if (err instanceof AmbiguousIdentityError)
      return { kind: "ambiguous", candidates: err.candidates, incoming: err.incoming, context: err.context };
    return { kind: "error", message: errorMessage(err) };
  }
}
