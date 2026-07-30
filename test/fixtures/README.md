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

Redaction is verified three ways, ALL of which must pass before a fixture is written. The first is
the one that decides whether the other two even matter:

1. **Allow-list policy** (`tools/fixture-policy.ts`) — runs FIRST, after substitution, over the
   redacted output. Every content atom (a text-node run, a comment body, or a non-structural
   attribute value) is reduced to a normalised "skeleton": every synthetic stand-in and every
   structural value (integers, decimals, US dates, set scores, hex colours, SVG path data) is
   elided, and what's left has its punctuation collapsed away. An atom whose skeleton is non-empty
   must already be listed in that source's committed vocabulary
   (`tools/fixture-vocabulary/tennisrecord.txt` / `usta.txt`) — a per-source file of skeletons a
   human has read and approved, name-shaped entries only with a justification line immediately
   above them.

   **What the vocabulary admits is a public/structural allow-list, not a "this is all invented"
   list.** A name-shaped entry is justified one of two ways, and they make different STRENGTHS of
   claim:
   - `# reviewed[synthetic]: <reason>` — an invented stand-in value from the substitution map.
     `loadVocabulary()` machine-checks this claim: every capitalised token in the entry must
     appear as a capitalised token somewhere in the committed `stand-ins.txt`, or the file fails
     to load outright. This marker exists so "synthetic" is never asserted on prose alone.
   - `# reviewed: <reason>` — every other honest classification, most commonly a **real, public**
     place, club, league, section, or tournament name (e.g. "Missouri Valley", "Leawood, KS",
     "Clayview Country Club"). Real public organisation and geography names ARE deliberately
     admitted here: they identify a place or an organisation, not a person, so they carry none of
     the privacy risk this policy exists to contain. **A real PERSON's identity is never admitted
     this way** — that is what the forbidden-value sweep and the structural detector sweep below
     exist to catch, and what `# reviewed[synthetic]:` exists to keep honest.

   Anything else — content nobody enumerated AND nobody structurally recognised — refuses the
   capture outright, reporting every unclassified atom with its skeleton, node kind and DOM path.
   The other two checks below are a **blacklist**: each one only catches an identity somebody
   thought to name or a shape somebody thought to detect. This check is the **inversion** —
   unrecognised content fails closed instead of shipping by default — and is what makes "every
   fixture's vocabulary is complete" a fact enforced by
   `test/fixtures-vocabulary-complete.test.ts` in CI, not a claim a human has to remember to
   re-verify.
2. **Forbidden-value sweep** — every listed identity, in every encoding, must be absent.
3. **Structural detector sweep** — every identity the page still advertises in its own markup
   (each `playername=` / `teamname=` in a TennisRecord href, each `uaid` and `tennis-id` on a USTA
   profile) is re-derived from the output and must be a synthetic value. This catches a name nobody
   remembered to list — and it did: it caught nine real surnames on the first real capture, where
   TennisRecord's mixed `teamname=Surname%2c First` encoding slipped past a whole-string matcher.

None of the three guarantees the page contains **zero** real identifying information in some
encoding or shape none of them was built to recognise — that is a stronger claim than any of these
checks can support, and this file does not make it. What they DO guarantee, each enforced by its
own test: every identity anyone listed is gone (1); every identity the page's own markup still
advertises through a known detector is synthetic (3); and every remaining atom — the class neither
of those two was ever built to see — is either provably synthetic/structural or has been read and
approved by a human (1). A synthetic stand-in's own vocabulary line does not need this reasoning
applied to it a second time: `tools/fixture-vocabulary/stand-ins.txt` holds only the invented
replacement values from the substitution map, safe to publish by construction (see that file's own
header for how it is derived and regenerated).

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

`--vocabulary <path>` is optional and defaults to `tools/fixture-vocabulary/<detector-set>.txt`. If
the capture introduces content the vocabulary doesn't already list, the capture refuses — read what
`PolicyError` reports, decide whether each skeleton is safe (structural/boilerplate, real-public, or
genuinely synthetic) or needs a human justification (name-shaped), then add it to the committed
vocabulary file and re-run the capture. A name-shaped entry needs `# reviewed[synthetic]: <reason>`
ONLY if it is truly an invented stand-in value — `loadVocabulary()` will refuse to load it unless
every capitalised token is backed by `stand-ins.txt`, so do not reach for this marker to make a real
place, club, league, or section name load; use the plain `# reviewed: <reason>` form for that (and
for boilerplate/UI-chrome) instead. `tools/bootstrap-vocabulary.ts` reports skeletons for a set of
fixtures and auto-writes the non-name-shaped ones; every name-shaped one still has to be
dispositioned by hand.
