// Fixture surgery for "this player no longer appears on the roster page" (issue #49), shared by
// every test that needs a CHANGED roster rather than a second captured fixture — synthesizing one
// by mutation keeps the fixture-vocabulary allow-list (`tools/fixture-policy.ts`) out of the
// critical path. Extracted here from `ingest-team-pull.test.ts` when the MCP surface needed the
// same mutation: a copy-paste into a second test file would have been one more place for the
// `<tr>`-bounding logic to drift from the fixture's actual markup.

/**
 * Removes ONE roster row (bounded by its nearest enclosing `<tr>...</tr>`) whose profile link
 * carries `playerName`. Bounded by literal `<tr`/`</tr>` markers rather than a hand-copied string
 * so it survives incidental whitespace in the committed fixture; this is test-fixture surgery, not
 * a parser, so a plain string search is proportionate here. Returns `null` (rather than throwing)
 * when no such row is found, so a caller can loop to remove every occurrence of a name that
 * legitimately repeats on the page (the team fixture repeats its whole roster table for a second,
 * unused view).
 */
export function removeOneRosterRow(html: string, playerName: string): string | null {
  const anchor = `<a class="link" href="/adult/profile.aspx?playername=${playerName}`;
  const anchorIndex = html.indexOf(anchor);
  if (anchorIndex === -1) return null;
  const rowStart = html.lastIndexOf("<tr", anchorIndex);
  const rowEnd = html.indexOf("</tr>", anchorIndex);
  if (rowStart === -1 || rowEnd === -1) {
    throw new Error(`removeOneRosterRow: could not bound the <tr> for "${playerName}"`);
  }
  return html.slice(0, rowStart) + html.slice(rowEnd + "</tr>".length);
}

/** Removes the FIRST occurrence of `playerName`'s roster row — the one `parseTennisRecordTeam`
 * actually reads (`tableWithCellText` matches the first `div.large` table with an NTRP column). */
export function removeRosterRow(html: string, playerName: string): string {
  const result = removeOneRosterRow(html, playerName);
  if (result === null) throw new Error(`removeRosterRow: no roster row found for "${playerName}"`);
  return result;
}

/** Removes every `names` entry's row from the FIRST (parsed) roster table, one call per name —
 * used to synthesize a roster page that parses to zero members. */
export function removeAllRosterRows(html: string, names: string[]): string {
  let result = html;
  for (const name of names) result = removeRosterRow(result, name);
  return result;
}

export type RosterPageOptions = {
  teamName: string;
  players: string[];
  seasonName?: string;
  leagueContext?: string;
  /**
   * Local-schedule rows to emit. Omitted/empty renders a HEADER-ONLY schedule table, which
   * `parseSchedule` tolerates — useful where a test needs a team with no fixtures at all.
   *
   * Supplying rows is what makes a pull actually exercise `parseSchedule`'s row path (date parsing,
   * the 5-cell width contract, opponent resolution, `mid=` extraction). Name an opponent that
   * ALREADY exists when you do not want the pull to mint a new team for it — every schedule row's
   * opponent cell resolves to a `teams` row, so an arbitrary name creates one.
   */
  schedule?: { date: string; time: string; opponent: string; site: string; result?: string }[];
};

/**
 * Synthesizes a minimal, from-scratch TennisRecord team page: a 3-row header block
 * (`src/parsers/tennisrecord/team.ts`'s `parseHeader` reads league context / season / team name,
 * one per row), a roster table satisfying its exact column and row-width contract
 * (`ROSTER_COLUMNS`/`ROSTER_ROW_CELLS`), and a local schedule table carrying whatever
 * `options.schedule` asks for — defaulting to HEADER-ONLY (zero body rows, which `parseSchedule`
 * tolerates) so a caller that wants a team with no fixtures does not mint phantom opponent teams
 * the way replaying the real captured `team.html` fixture's own ten-row schedule would.
 *
 * Defaulting to header-only is a convenience, NOT the right choice for a pipeline test: with zero
 * schedule rows, `parseSchedule` returning `[]` and `parseSchedule` being outright broken are
 * indistinguishable, so a dry run built only on header-only pages cannot detect a schedule-parser
 * regression at all (independent Reviewer finding, PR #58). Pass `schedule` when the point is to
 * exercise the pipeline.
 *
 * Built from scratch rather than mutating `team.html` (issue #19's dry run: "aligning the
 * payload's names with a synthesized roster page is the friction point of this whole task"). The
 * captured fixture's team name and all 18 roster names are literal text baked into real markup, so
 * swapping in a scorecard payload's own names in place would still leave every OTHER roster row —
 * and the header's own team name — pointing at unrelated stand-ins, and its ten schedule rows would
 * each mint a new opponent team on every pull.
 */
export function buildRosterPage(options: RosterPageOptions): string {
  const seasonName = options.seasonName ?? "2026 Test Season";
  const leagueContext = options.leagueContext ?? "Adult 18+ Missouri Valley M 4.0";
  const rows = options.players
    .map(
      (name) => `
        <tr>
          <td><a class="link" href="/adult/profile.aspx?playername=${name}">${name}</a></td>
          <td>Somewhere, ZZ</td>
          <td>4.0</td>
          <td>5-3</td>
          <td>2-1</td>
          <td>1-2</td>
          <td>3-3</td>
          <td>4.05</td>
          <td></td>
        </tr>`,
    )
    .join("\n");

  const scheduleRows = (options.schedule ?? [])
    .map(
      (row) => `
        <tr>
          <td>${row.date}</td>
          <td>${row.time}</td>
          <td>${row.opponent}</td>
          <td>${row.site}</td>
          <td>${row.result ?? ""}</td>
        </tr>`,
    )
    .join("\n");

  return `<html><body>
    <table>
      <tr><td>${leagueContext}</td></tr>
      <tr><td>${seasonName}</td></tr>
      <tr><td>${options.teamName}</td></tr>
    </table>
    <div class="large">
      <table>
        <tr>
          <th>Name</th>
          <th>Location</th>
          <th>NTRP</th>
          <th>2026 Record</th>
          <th>Local Singles</th>
          <th>Local Doubles</th>
          <th>Local Record</th>
          <th colspan="2">Rating</th>
        </tr>
        ${rows}
      </table>
    </div>
    <div class="large">
      <table>
        <tr>
          <th>Local Schedule</th>
          <th>Time</th>
          <th>Opponent</th>
          <th>Match Site</th>
          <th>Result</th>
        </tr>
        ${scheduleRows}
      </table>
    </div>
  </body></html>`;
}
