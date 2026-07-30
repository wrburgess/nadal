# Parser fixtures

Real captured pages, redacted. Spec § Testing requires parsers to be tested against **captured
pages** with expected values hand-verified once — regression anchors, not snapshot tautologies.

Each `<name>.html` has a sibling `<name>.html.provenance.json` recording its source URL, capture
time, HTTP status and byte counts. `test/helpers/fixtures.ts` loads the pair, so no test invents a
URL or a fetch date.

## Redaction

**This repository is public and these pages are about real people**, so every fixture is passed
through `tools/redact-fixture.ts` before it is committed:

- Personal identities — names, city/state locations, USTA uaids, ITF tennis ids — are replaced
  with synthetic stand-ins. The same person maps to the same stand-in across every fixture.
- `<script>` and `<style>` bodies and base64 `data:` payloads are stripped.
- **Nothing else changes.** Every element, class and attribute a parser reads is byte-identical to
  what the server sent, which is the entire reason for using captured pages rather than authored
  ones. The redaction tool's own test asserts that the element tree survives unchanged.
- The `sourceUrl` in each provenance file is redacted with the same map, because a TennisRecord URL
  carries the player's name and a USTA profile URL carries the uaid.

The substitution map is **not** in this repository, by design: it pairs each real identity with its
stand-in, so committing it would publish exactly what redaction removes. It is passed with
`--map <path>` from outside the repo.

Redaction is verified two ways, both of which must pass before a fixture is written:

1. **Forbidden-value sweep** — every listed identity, in every encoding, must be absent.
2. **Structural detector sweep** — every identity the page still advertises in its own markup
   (each `playername=` / `teamname=` in a TennisRecord href, each `uaid` and `tennis-id` on a USTA
   profile) is re-derived from the output and must be a synthetic value. This catches a name nobody
   remembered to list — and it did: it caught nine real surnames on the first real capture, where
   TennisRecord's mixed `teamname=Surname%2c First` encoding slipped past a whole-string matcher.

## Fixtures

| Fixture | Source | Why this page |
|---|---|---|
| `tennisrecord/profile.html` | `profile.aspx` | Header, playing areas, recent teams (18+ *and* 40+), per-season aggregates |
| `tennisrecord/player-stats.html` | `playerstats.aspx` | Second page carrying the shared header, so "the header is shared" is asserted rather than assumed |
| `tennisrecord/match-history.html` | `matchhistory.aspx?year=2025` | 14 courts covering S1/D1/D2/D3, two match tiebreaks, four unrated players, five self-rated matches, one default |
| `tennisrecord/match-history-empty.html` | `matchhistory.aspx?year=2014` | A season with no matches: the table and its header ship, zero data rows — so "no matches" stays distinguishable from "the table is gone" |
| `tennisrecord/team.html` | `teamprofile.aspx` | 18-player roster with ratings, an ALL-CAPS name, and a second `div.large` block (the schedule) that a container-only selector would mis-parse as roster |
| `usta/profile-wtn-both.html` | `player-search/profile.html#uaid=…` | NTRP with rating type and effective date; WTN singles *and* doubles with confidence and game zone |
| `usta/profile-wtn-doubles-only.html` | `player-search/profile.html#uaid=…` | A genuine profile with a doubles WTN and **no** singles WTN |

The USTA pages are post-render DOM from a login-assisted capture (the profile page is a
client-rendered SPA); the TennisRecord pages are public and were fetched directly.

## Not here: TennisLink

TennisLink team, player-history and scorecard fixtures are absent because every
`tennislink.usta.com` league and tournament path now redirects to `account.usta.com` OAuth. Spec
§ Ingestion classifies TennisLink as a public path; it is now a login-assisted one. Capturing these
needs an HC login session — see `docs/findings.md` and the tracked follow-up issue.

## Re-capturing

```sh
tsx tools/capture-fixture.ts --url <url> --map <path outside the repo> \
    --detectors tennisrecord|usta --out test/fixtures/<source>/<name>.html
```

Use `--file <path> --source-url <url>` instead of `--url` for a page taken from an existing archive
of a login-assisted capture.
