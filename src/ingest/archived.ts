import { readFileSync } from "node:fs";
import type { players } from "../db/schema.js";
import { errorMessage } from "../error-message.js";
import { ParseError, parseUstaProfile, parseWtnWidget } from "../parsers/index.js";
import { archivePage } from "./archive.js";
import type { Db } from "./db-types.js";
import { AmbiguousIdentityError } from "./errors.js";
import { resolvePlayer } from "./identity.js";
import { slugFromUrl } from "./player-pull.js";
import { upsertPlayer, upsertRatingObservation } from "./upsert.js";

type PlayerRow = typeof players.$inferSelect;

export type ArchivedUstaPullOptions = {
  db: Db;
  /** A local file the HC saved from a logged-in browser session — never fetched by this tool. */
  path: string;
  /** The real page URL, supplied by the HC since a saved file carries none of its own. */
  sourceUrl: string;
};

export type ArchivedUstaPullResult =
  | { kind: "ok"; player: PlayerRow; archivedPath: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "error"; message: string };

/**
 * The login-assisted ingestion path: USTA (and, riding along on the same page, WTN) sit behind an
 * account login that this tool never automates (spec § Ingestion path 2; no browser dependency in
 * this PR — see `docs/runbooks/login-assisted-scrape.md`). The HC saves the already-rendered page
 * from their own logged-in session; this function archives that file exactly like a live fetch
 * (so it lands in the same raw/ substrate, redaction pipeline, and re-parse story), then runs BOTH
 * parsers over the one set of bytes — one fetch, two parsers, per `src/parsers/wtn/widget.ts`'s
 * own doc comment: the WTN widget is embedded IN the USTA profile page, not a second page.
 */
export async function pullArchivedUstaProfile(
  options: ArchivedUstaPullOptions,
): Promise<ArchivedUstaPullResult> {
  const { db, path, sourceUrl } = options;
  const body = readFileSync(path, "utf8");

  const archivedPath = archivePage({
    sourceSet: "usta",
    slug: slugFromUrl(sourceUrl),
    url: sourceUrl,
    body,
    httpStatus: 200,
  });

  const source = { url: sourceUrl, fetchedAt: new Date().toISOString() };
  let usta;
  let wtn;
  try {
    usta = parseUstaProfile(body, source);
    wtn = parseWtnWidget(body, source);
  } catch (err) {
    if (err instanceof ParseError) return { kind: "error", message: err.message };
    throw err;
  }

  const observedOn = source.fetchedAt.slice(0, 10);

  try {
    const player = db.transaction((tx) => {
      const wtnTennisId = usta.wtnTennisId ?? wtn?.tennisId ?? null;
      const resolved = resolvePlayer(tx, { ustaUaid: usta.uaid, wtnTennisId, name: usta.name });
      if (resolved.kind === "ambiguous") {
        throw new AmbiguousIdentityError(resolved.candidates.map((p) => p.canonicalName));
      }
      const updated = upsertPlayer(tx, {
        id: resolved.row.id,
        canonicalName: usta.name,
        ustaUaid: usta.uaid,
        wtnTennisId,
        gender: usta.gender,
      });

      if (usta.ntrp !== null) {
        upsertRatingObservation(tx, {
          playerId: updated.id,
          source: "ntrp",
          value: usta.ntrp.value,
          ratingType: usta.ntrp.ratingType,
          observedOn: usta.ntrp.observedOn,
        });
      }
      // WTN carries no date of its own (the widget shows only a current value), so the capture
      // date is the only honest `observedOn` available.
      if (wtn?.singles !== null && wtn?.singles !== undefined) {
        upsertRatingObservation(tx, {
          playerId: updated.id,
          source: "wtn_singles",
          value: wtn.singles.value,
          ratingType: null,
          observedOn,
        });
      }
      if (wtn?.doubles !== null && wtn?.doubles !== undefined) {
        upsertRatingObservation(tx, {
          playerId: updated.id,
          source: "wtn_doubles",
          value: wtn.doubles.value,
          ratingType: null,
          observedOn,
        });
      }

      return updated;
    });

    return { kind: "ok", player, archivedPath };
  } catch (err) {
    if (err instanceof AmbiguousIdentityError) return { kind: "ambiguous", candidates: err.candidates };
    return { kind: "error", message: errorMessage(err) };
  }
}
