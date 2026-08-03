# Runbook: login-assisted scrape (USTA / WTN)

## When to use this

`tn player pull` fetches TennisRecord live because TennisRecord's team, match-history, and
player-profile pages are public (`docs/findings.md`, 2026-07-30). USTA's player-search profile —
and the WTN widget embedded inside it — is **not**: every `tennislink.usta.com` and
`usta.com/en/home/play/player-search` path now requires a signed-in `account.usta.com` session.
Phase 3 (#15, option A "seam-first") deliberately ships **no browser dependency** — no Playwright,
no automated login — so this page can only be captured with a human already logged in.

That's what this runbook is: how the HC hands a saved, logged-in page to `tn player pull` so it
still gets archived, parsed, and written like any other pull, just without this tool ever touching
the USTA login form itself.

## Why this is manual in v1

- **No browser dependency in this PR.** Automating USTA's login (credentials, MFA, session
  refresh) is real scope with its own security posture — out of scope for the seam-first plan that
  shipped Phase 3. It's tracked separately, the same way TennisLink's OAuth gate is (#27).
- **The seam is already there.** `src/ingest/archived.ts` takes a saved HTML file plus the page's
  real URL and runs it through the exact same archive → parse → upsert pipeline a live fetch would
  — `tn player pull` doesn't know or care that the bytes came from a browser session instead of
  `fetch()`. When automated login lands, it plugs into this same seam; this runbook's manual steps
  become that automation's job instead of the HC's.

## Steps

1. **Sign in.** In a normal browser, log into `https://www.usta.com` (or `account.usta.com`) with
   an account that can reach the player-search profile pages.
2. **Navigate to the player's profile.** USTA's player-search profile is a client-rendered SPA at
   `https://www.usta.com/en/home/play/player-search/profile.html#uaid=<uaid>`. Load the player you
   want, and wait for the page to finish rendering — the identity block, NTRP rating, and (when the
   player has one) the WTN widget all render client-side after the initial load.
3. **Save the rendered page.** Use the browser's "Save Page As… → Webpage, Complete" (or
   equivalent) to save the **post-render DOM**, not the initial server response — the WTN widget in
   particular only exists after client-side rendering completes. Note the exact URL in the address
   bar, including the `#uaid=...` fragment: the uaid lives ONLY in that fragment and nowhere in the
   page body (`src/parsers/usta/profile.ts`), so a saved page without its real URL can't be
   resolved to a player at all.
4. **Hand it to `tn player pull`.**
   ```
   tn player pull usta:<uaid> --from <path/to/saved.html> --source-url "<the exact URL from step 3>"
   ```
   `usta:` (or `wtn:` — they route the same way, since WTN rides on the USTA page rather than being
   a separate fetch) tells the CLI this is the login-gated path; `--from`/`--source-url` are
   required together for it. The command archives the saved file under `raw/usta/` exactly like a
   live fetch would, then runs `parseUstaProfile` **and** `parseWtnWidget` over the same bytes —
   one page, two parsers, never two fetches.
5. **Read the summary line.** `player pull status=ok player="…" matches=0 archived="…"` (a USTA
   profile carries no match history — that's TennisRecord's job) confirms the write. A
   `status=error` line means the saved page didn't have the shape the parser expects — most often a
   page saved before client-side rendering finished (see step 3).

## Verifying the pull landed

- The archived raw page lives at the path in `archived="…"` — reopen it to confirm it's the
  complete, rendered page and not a partial/error state.
- `tn db migrate`'s own `data/nadal.db` now has the player's `usta_uaid`, `wtn_tennis_id` (when the
  page carried one), and a dated `ntrp`/`wtn_singles`/`wtn_doubles` row in `rating_observations`
  (WTN carries no date of its own, so it's stamped with the capture date).
- Re-running the same command with the same `--source-url` updates the same player in place rather
  than creating a duplicate — `src/ingest/identity.ts`'s tier-1 `usta_uaid`/`wtn_tennis_id` match.

## Known limitations

- This tool never automates the USTA login. If the session expires mid-capture, sign in again and
  re-save.
- An ambiguous player name (ties `src/ingest/identity.ts`'s tier-3 fuzzy match) aborts the write and
  reports three facts: the **incoming** name, **where** it came from, and the candidates it is
  **near** (#94). Rule on it with `tn player distinct "<incoming>"` (different people) or
  `tn player alias "<candidate>" "<incoming>"` (same person, two spellings), then re-run. Nothing is
  ever silently merged, and neither command merges two existing rows — that is still an HC job.
