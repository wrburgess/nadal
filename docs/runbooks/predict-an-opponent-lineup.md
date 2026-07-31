# Runbook: predict an opponent's lineup

## When to use this

Before a team match, to see how an opponent is likely to field its courts —
spec § Deliverables #1's *"a predicted lineup honestly labeled a guess"*. The same prediction is
rendered into every dossier by `tn report build`, so this command is for when you want it on its
own, or want to check it before printing the binder.

**Read the label, not just the table.** This is a guess assembled from what a team has been *seen*
to do. It is not a lineup card, it does not know about injuries, travel, or what the opposing
captain decided last night, and it has never been validated against a real Sectionals result —
there was no real data in the system when the rule was written. Treat a `low`-confidence row as a
coin flip with extra steps.

## What the rule actually is

Stated once here so the output can be argued with rather than merely read:

1. **Singles courts** go to the player with the most singles court matches on file. Ties go to the
   better-rated player, then to the lower player id.
2. **Doubles courts** go to partnerships — every pair of teammates seen together on the same side
   at least **twice**. Each pair contends for the court it most often shared; if two pairs want the
   same court, the **better combined rating** takes it and the other cascades to its own
   next-most-shared court, then to any open one.
3. **Ratings fill every gap.** Anyone left over is paired best-with-best and placed in the
   remaining courts. Those rows read `placed by rating — no shared history`.
4. **Nobody is dropped.** Players who did not fit are listed with their match counts, and a court
   with nobody left reads `unfilled`.

Three limits worth knowing before you rely on it:

- **Only this team's own matches count.** Your opponents play in other leagues too, and a pairing
  they formed on an 18+ team tells you nothing about how *this* team fields courts — so anything not
  linked to one of this team's matches is excluded, and the output tells you how many were set
  aside. If a prediction looks thinner than the roster's experience suggests, read that line: it is
  usually the explanation.

- **The courts predicted are the courts this team has been seen to field**, not the courts the
  event fields. A team with a five-court league history is predicted across five even at
  Springfield's four, because nothing in the data links a team to an event yet. The output always
  prints the court count and says where it came from.
- **Ranking happens inside one rating scale**, whichever covers the most of that roster
  (TennisRecord dynamic → NTRP → WTN doubles → WTN singles). Comparing an NTRP number against a
  TennisRecord number is not meaningful, so it is not done; anyone missing that scale is listed as
  unrated and sorts last.

## Before you start

- The database has been migrated: `tn db migrate`
- The opponent has been pulled **with their roster's match histories**:
  `tn team pull "<team>" --players`. Without `--players` there are no court matches, and the
  command will refuse.

## Steps

### 1. Check there is something to predict from — by running the prediction

```
tn lineup plan "IA/Versteeg/40&Over3.5M"
```

**Do not use `tn team show`'s `slots:` line as the preflight.** It is tempting and it is wrong: that
line counts *every* court match the roster's players appear in, including their other leagues, while
the prediction counts only matches belonging to **this team**. A roster whose players have long
histories elsewhere will show a healthy `slots:` line and then have `lineup plan` refuse — and you
would go looking for the wrong problem.

The prediction is its own preflight. Either it renders, or it refuses and tells you what to run:

```
lineup plan status=error message="no court-match history on file for "…" — only this team's own
matches count, so run tn team pull --players for it first"
```

If it renders but names only one or two courts, expect a thin guess — and read the `excluded:` line,
which says how many of the roster's matches belonged to other teams.

### 2. Run the prediction

```
tn lineup plan "IA/Versteeg/40&Over3.5M"
```

Expected shape:

```
PREDICTED LINEUP — IA/Versteeg/40&Over3.5M
  This is a guess, not a lineup card. Based on 24 observed court matches across a roster of 8.

  S1   Ada Ashby      conf: high    12 singles matches
  D1   Bo Bramwell    conf: high    8 matches together
       Cy Calder
  D2   Del Duxbury    conf: medium  3 matches together
       Emory Ellerby
  D3   Ira Inglewood  conf: low     placed by rating — no shared history
       Juno Jarrow

  not placed: Kit Kestrel (0 court matches)
  ratings: ranked within NTRP; unrated: Kit Kestrel
  courts: 4, from this team's observed match history (not the event format)
```

### 3. Read it critically

- **`conf: high`** — five or more supporting matches. Worth planning against.
- **`conf: medium`** — two to four. A real pattern, thin evidence.
- **`conf: low` with a match count** — one shared match, or a singles player with almost no singles
  history. Barely better than a guess.
- **`placed by rating — no shared history`** — the model had nothing to go on and sorted by
  strength. Do not read this row as a prediction about *pairings* at all.
- **`not placed`** — check the match counts. A strong player with `0 court matches` means the pull
  did not reach their history, not that the team will bench them.

### 4. Use it in agent chat for your own lineup

Your own lineup is not this command's job — spec § Deliverables #3 puts that in agent chat, where
you can talk through pairings, heat, and double-duty days. Start the MCP server
([agent-chat-over-mcp.md](agent-chat-over-mcp.md)) and ask for `lineup_plan` on the opponent
alongside `team_show` on your own team; the tool returns the same structured prediction with its
confidence and basis fields intact.

### 5. Record availability first, if you are planning your own side

Availability is per-player per-event-day, and it needs an event to exist:

```
tn event add "Springfield Sectionals 2026" tournament 2026-08-28 2026-08-30
tn player avail "Randy Burgess" 2026-08-29 available
tn player avail "Halksworth"     2026-08-28 unavailable
```

`tn event add` is idempotent on the event name — re-running it updates the range in place rather
than creating a second event. `tn player avail` only accepts players on the **designated home
team** (`tn team home "<your team>"`), by design.

**If a day belongs to two events, name the one you mean.** A league season and a tournament inside
it both cover the same May days, so `tn player avail` refuses that day rather than guessing, and
lists the candidates. Add the event as a fourth argument:

```
tn player avail "Randy Burgess" 2026-05-16 available "Heart of America Districts"
```

Availability is stored per (player, event, day), so the same player and day can carry a different
status for each overlapping event — which is what you want when the two are genuinely different
commitments.

## Manual test segment (for the HC)

Run these in order against a scratch database and confirm each expectation:

```
export TN_DB_PATH=/tmp/lineup-check/nadal.db
tn db migrate
tn team pull "IA/Versteeg/40&Over3.5M" --players
tn lineup plan "IA/Versteeg/40&Over3.5M"
```

1. The output begins `PREDICTED LINEUP` and contains the sentence **"This is a guess, not a lineup
   card"**. If that sentence is ever missing, the honesty requirement has regressed — that is a
   defect, not a formatting nit.
2. Every court row carries a confidence and either a match count or
   `placed by rating — no shared history`.
3. The final two lines name the rating scale used and the court count with its source.
4. No line contains `player #` followed by a number — that would be a raw database id leaking into
   output meant for a human.
5. `tn lineup plan "<a team you have not pulled>"` exits **non-zero** and tells you to run
   `tn team pull --players` — it must never print an empty lineup.
6. `tn lineup plan "<team>" --json` parses as JSON and carries `confidence`, `basis`, `support`,
   `ratingSource` and `slotSource` fields.
7. `tn report build "<team>"` writes a dossier whose markdown contains a
   **"Predicted lineup (a guess)"** section matching what step 2 printed.
8. Add a second, overlapping event and confirm the disambiguator works:
   `tn event add "HOA Spring 2026" league 2026-03-01 2026-06-30` then
   `tn player avail "<a home-team player>" 2026-05-16 available` must **refuse** and list both
   events; re-running it with the event name as a fourth argument must succeed.

## If it refuses

| Message | What it means |
|---|---|
| `no court-match history on file for "<team>"` | No court matches belonging to **this team** were ingested — its players may still have plenty of history for other teams, which does not count. Re-run `tn team pull "<team>" --players`, which writes the schedule the player pulls then link against. |
| `unknown target "<team>"` | No team by that name. `tn team show` with a partial name to find the spelling. |
| `ambiguous target: A, B` | More than one team matches. Use the full name, or `tr:<url>`. |
