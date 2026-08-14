import { parseTennisRecordTeam } from "../../src/parsers/index.js";
import { hrefParam } from "../../src/parsers/dom.js";
import { matchHistoryUrlFor } from "../../src/ingest/player-pull.js";
import type { Fixture } from "./fixtures.js";

/**
 * Issue #167. TennisRecord disambiguates same-named players with an `&s=<n>` NAMESAKE INDEX on the
 * roster link, and the cascade must carry it into the match-history URL it fetches — without it the
 * request resolves to that name's default profile, which is a different person.
 *
 * Every test harness that registers stub fixtures for a cascade needs to key them at the URLs the
 * cascade will actually request. Two harnesses already did this independently, each with its own
 * hardcoded copy of the fixture's roster names, and both agreed with production only because all
 * three dropped `&s=` alike — a false green that held across the whole suite.
 *
 * So the index is DERIVED FROM THE FIXTURE'S OWN HREFS here rather than restated anywhere: the
 * fixture bytes are the single source of truth, and a harness added tomorrow cannot reintroduce the
 * defect by forgetting a list. Same rule the production path now follows — read the index off the
 * link, never rebuild the URL from the name alone.
 */
export function namesakeIndexFrom(teamFixture: Fixture): Map<string, string> {
  const parsed = parseTennisRecordTeam(teamFixture.html, teamFixture.source);
  const index = new Map<string, string>();
  for (const entry of parsed.roster) {
    if (entry.profilePath === null) continue;
    const playername = hrefParam(entry.profilePath, "playername");
    const s = hrefParam(entry.profilePath, "s");
    if (playername === null || playername === "" || s === null || s === "") continue;
    index.set(playername, s);
  }
  return index;
}

/**
 * A `(name, year) -> URL` builder bound to one team fixture's namesake indices — the URL that
 * fixture's cascade will actually request for that roster name.
 */
export function cascadeUrlBuilderFor(teamFixture: Fixture): (name: string, year: string) => string {
  const index = namesakeIndexFrom(teamFixture);
  return (name, year) => matchHistoryUrlFor(name, year, index.get(name));
}
