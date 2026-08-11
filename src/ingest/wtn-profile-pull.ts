import { readFileSync } from "node:fs";
import type { players } from "../db/schema.js";
import { errorMessage } from "../error-message.js";
import { ParseError, parseWtnProfile } from "../parsers/index.js";
import { archivePage } from "./archive.js";
import type { Db } from "./db-types.js";
import { AmbiguousIdentityError, type AmbiguousIdentity } from "./errors.js";
import { resolvePlayer } from "./identity.js";
import { normalizeGender } from "./normalize-gender.js";
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
 * `wtnTennisId` IS written back unconditionally: `resolvePlayer`'s id tier only SEARCHES on it, it
 * does not backfill it onto a player found instead via the name tier, and leaving that gap open
 * would mean the very identity this call just resolved is not durably on the row it resolved to.
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
      return upsertPlayer(tx, {
        id: resolved.row.id,
        wtnTennisId: profile.tennisId,
        ageRange: profile.ageRange,
        // The page prints "Male"/"Female" already — this project's own stored vocabulary — but the
        // write still routes through `normalizeGender` (issue #130) rather than trusting that: it
        // is the one place every writer of `players.gender` meets, and skipping a writer here is
        // exactly how the column ended up with two that disagreed in the first place.
        gender: normalizeGender(profile.gender),
      });
    });

    return { kind: "ok", player, archivedPath };
  } catch (err) {
    if (err instanceof AmbiguousIdentityError)
      return { kind: "ambiguous", candidates: err.candidates, incoming: err.incoming, context: err.context };
    return { kind: "error", message: errorMessage(err) };
  }
}
