# Runbook: in-event screenshot ingest

## When to use this

At a Sectionals site (or any tournament), when a scorecard photo needs to be in the system before
the next round is planned — spec § Ingestion path 4: "Friday's results in the system before
Saturday's planning" comes from photos, not a parser. `tn` cannot read the photo itself: there is no
OCR or image-decoding dependency in this repo (see the assessment for #18), and the seam the spec
already puts here is **agent vision → a structured payload → a deterministic writer**. The model
sees the photo; `tn` validates and writes.

## Before you start

- The database is migrated (`tn db migrate`).
- **Both teams are already on file, with their rosters pulled** (the prompt form in
  [pre-tournament-full-pull.md](pre-tournament-full-pull.md) step 2 — never paste a scraped team
  name between quotes
  for each side, or the equivalent `team_pull`/`player_pull` MCP calls). `tn match add` / `match_add`
  never creates a team, and every player name resolves ONLY against the named team's own roster
  (never a global lookup) — a team or a roster that does not exist yet cannot be matched into, no
  matter how clearly the photo reads.
- If the match belongs to a tracked event (a Sectionals or league season), the event is already on
  file (`tn event add`). Naming an unknown event in the payload is a refusal, not a create.

## Steps

### 1. Hand the photo to an agent chat connected to `tn mcp serve`

See [agent-chat-over-mcp.md](agent-chat-over-mcp.md) for connecting a client. Share the scorecard
photo in the conversation and ask the agent to extract it — e.g.:

> "Read this scorecard photo and record the results with `match_add`. Home team is
> `HOA/Burgess-Zingg/40&over3.5M`, visiting team is the one printed on the card."

The agent's job is to produce ONE JSON object matching `src/ingest/scorecard.ts`'s
`scorecardPayloadSchema`: the played-on date, both team names, and one entry per court (`slot`,
`discipline`, `homePlayers`/`visitingPlayers` by name, and — when the card shows them — `winnerSide`
and `score`). The slot set is whatever the card actually shows (`S1`/`D1`-`D3` at a four-court
event, `S1`/`D1`-`D4` at a five-court one like Tulsa 2025) — it is never assumed to be exactly four.

### 2. The agent calls `match_add`

Over MCP, the agent calls the `match_add` tool with that payload inline — it has no file to hand,
which is the whole reason this tool exists alongside the CLI command below. If a `sourceImage` path
is available (the photo saved to disk), including it archives the original bytes to `raw/`
(gitignored), exactly like every other raw capture this repo makes — with two conditions specific
to this path, both hardened after a Codex adversarial review found `sourceImage` was otherwise an
arbitrary local-file-read primitive (rated Critical):

- **The photo must already sit inside the configured scorecard-photos root** —
  `TN_SCORECARD_PHOTOS_PATH` if set (resolved against the caller's cwd when relative), or
  `scorecard-photos/` (gitignored) anchored to the `tn` checkout itself otherwise (issue #111 — the
  same directory no matter which directory `tn` was invoked from), mirroring
  `TN_DB_PATH`/`TN_RAW_PATH`/`TN_REPORTS_PATH` exactly. A path outside that root, or a symlink
  anywhere in the chain to it, is refused rather than read. Save (or move) the photo there before
  calling `match_add`.
- **Archiving happens AFTER the match is recorded, not before.** A refused ingest (an unknown team,
  an unresolved player, anything) persists nothing — the photo is read only once the database write
  has already succeeded. A photo that then fails to archive (a bad path, an oversized file, content
  that does not sniff as a real image) does NOT undo the match: the CLI reports `status=partial`
  (`match_add` returns `archiveError` alongside a normal successful result) rather than pretending
  nothing happened, since the match rows genuinely exist either way.

### Alternative: a payload file, from the CLI

If the payload already exists as a JSON file (an agent wrote it out, or you are replaying a captured
extraction), the identical service is reachable from a terminal:

```sh
tn match add /path/to/payload.json
```

**`tn match add` cannot read the photo itself.** Handing it an image, or a file that is not valid
JSON matching the schema, refuses (exit 1) with a message pointing at the `match_add` MCP tool —
this is a stated capability split, not a bug: only the agent's vision call can turn a photo into a
payload.

### 3. Verify what actually landed

`match_add`'s (and `tn match add`'s) own result is the readback — `teamMatchId` and a `courts` count
on success. Beyond that:

```sh
# Read the SAME database the ingest wrote to. A hardcoded `data/nadal.db` silently reads a stale
# file whenever TN_DB_PATH is set, and — since SQLite creates on open — conjures an empty decoy when
# that path holds nothing, so the readback would "verify" a match that is not in the database you
# just wrote. The `${TN_DB_PATH:-data/nadal.db}` fallback below has the same requirement as every
# other runbook's: it re-derives the unset default against THIS shell's cwd, so it only agrees with
# `tn`'s own anchored default (issue #111) when this shell IS the checkout root.
DB="${TN_DB_PATH:-data/nadal.db}"
[ -f "$DB" ] || { echo "STOP: no database at $DB — check TN_DB_PATH" >&2; exit 1; }
case "$DB" in
  *'?'*|*'#'*|*'%'*) echo "STOP: database path must not contain ? , # or % ; got '$DB'" >&2; exit 1 ;;
esac

# The id the command printed. Checked numeric before it reaches SQL: it is pasted from output, and a
# readback should not be the one place a value goes into a query unvalidated.
printf 'teamMatchId from the summary line: '; IFS= read -r TMID
case "$TMID" in
  ''|*[!0-9]*) echo "STOP: teamMatchId must be digits; got '$TMID'" >&2; exit 1 ;;
esac

# Read-only: verifying a write must never itself write.
sqlite3 "file:$DB?mode=ro" "select cm.slot, cm.discipline, cm.winner_side, cm.score
  from court_matches cm
  where cm.team_match_id = $TMID
  order by cm.slot"
```

Confirm the slot, discipline, winner, and score against the photo itself, not just against "the
call returned ok" — the same discipline this repo's own findings log names for the identical shape
(`docs/findings.md`: reading back what a write actually recorded, not merely that it succeeded).

## When a name is flagged

If any player name on the card cannot be resolved against the named team's roster — misspelled,
not on the roster at all, or ambiguous against more than one roster name within a couple of
characters — the **whole ingest refuses and writes nothing**, listing every flagged name together
(not just the first one hit). This is deliberate: spec § Ingestion requires "every extracted name
must resolve against known rosters or is flagged, never guessed," and a partial write would leave a
court's participants half-recorded with no signal that anything was wrong.

To fix a flagged name, either:

- **Correct the spelling** in the payload to match the roster exactly (or an existing alias), and
  re-run; or
- **Supply a prefix-ID** instead of the bare name — `usta:<uaid>`, `tr:<tennisrecord-url>`, or
  `wtn:<tennis-id>` — the same disambiguation idiom every other target in this grammar uses. It
  looks the identity up globally by source id, which is exactly what you want when the card's
  handwriting is ambiguous but you know who it is. It does **not** bypass roster scoping: an id
  naming someone who is not on this team's current roster is flagged `off-roster`, same as a bare
  name would be (PR #54, High finding 1 — this line used to say a prefix-ID "overrides roster
  scoping entirely", which stopped being true when that hole was closed and nothing here noticed); or
- **Record the card's spelling as an alias** of the roster player it belongs to —
  `tn player alias "<roster name>" "<what the card says>"` (#94) — when the same variant will keep
  turning up. Unlike the two fixes above, this one is durable: it settles the spelling once, for
  every future scorecard and pull, rather than for this payload.

Re-running the corrected payload is safe: the ingest is idempotent on `(playedOn, the team pair,
slot)`, so a retry after a fix does not create a second row for the courts that already resolved
correctly the first time — it simply succeeds where it previously refused.

## Known limitations

- **No in-process image reading.** This repo has no OCR/vision/image dependency; a photo must go
  through an agent's own vision, never `tn` directly.
- **A team must already exist and carry the roster the card names.** Neither `tn match add` nor
  `match_add` creates a team or a roster entry — that stays `team pull`'s job.
- **The general event↔team association is out of scope here** (`docs/findings.md`): a payload
  naming a known event links the match to it; naming none writes a match with no event at all,
  same as every other id-less team match on file today.
- **`sourceImage` only accepts JPEG and PNG**, sniffed from content rather than trusted from the
  extension, up to 25 MiB. HEIC (the default format on many phones) and WEBP are not yet supported —
  convert or re-save the photo first, or supply the payload without `sourceImage` and archive it
  separately.
