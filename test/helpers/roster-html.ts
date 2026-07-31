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
