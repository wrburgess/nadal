# Runbook: capture a WTN profile (age range + gender)

## When to use this

To populate `players.age_range` — and, from the same line, a normalized `players.gender` — for a
player who has an ITF id on file. The source is the World Tennis Number profile page:

```
https://worldtennisnumber.com/eng/player-profile?tennis-id=<ITF id>
```

It renders one line of the form `Male | 41-50 | USA`. That line is all this runbook is for.

**It is not a rating source.** Issue #132 settled that the dossier's WTN numbers come from the
ITF widget embedded in the USTA profile page; the parser this runbook feeds
(`src/parsers/wtn/profile.ts`) deliberately emits no ratings. If you want ratings, you want
[login-assisted-scrape.md](login-assisted-scrape.md) instead — and note that runbook's title says
"USTA / WTN" because the WTN **widget** rides on the USTA page. The page here is a different page.

## Why this is manual, and why it is NOT the login case

This is the distinction worth reading before you start, because the neighbouring runbook is about a
different problem:

|  | login-assisted-scrape.md | this runbook |
|---|---|---|
| Barrier | the page needs a signed-in session | the page needs **JavaScript to run** |
| Is it public? | no | **yes — no login, no account, no token** |
| Does `curl` work? | no (redirects to login) | no — returns a **data-less shell** |

Measured 2026-08-10: a plain fetch of the profile URL returns **HTTP 200 and 25,682 bytes containing
no rating, no gender and no age range.** The page is a client-rendered SPA that fetches its data from
`prd-itf-kube.clubspark.pro/graphql` after boot. Loaded in a **logged-out** browser it renders the
identity line fine — so nothing here needs credentials, and you should not sign in to do it.

The consequence for capture: what you save must be the **post-render DOM**, not the served bytes.

## Steps

1. **Open the profile URL in a normal browser** and wait for the name and the `Male | 41-50 | USA`
   line to actually appear. A page saved mid-render parses as a structural miss — the single most
   common cause of a failed capture.

   > Sections further down the page (*Player level*, *World Tennis Number history*) show
   > "you will need to be logged in". **That is expected and does not affect this capture** — the
   > identity line is public. Do not log in to make those go away.

2. **Save the rendered DOM to a file.** What lands on disk must be the same shape every
   `raw/usta/*.html` already has: a DOM dump beginning `<html lang="en"><head>`, not a Chrome
   "Webpage, Complete" bundle with rewritten `_files/` asset paths.

3. **Ingest it:**

   ```sh
   export TN_DB_PATH=/Users/wrburgess/Projects/aaa/nadal/data/nadal.db
   export TN_RAW_PATH=/Users/wrburgess/Projects/aaa/nadal/raw

   bin/tn player pull "wtn-profile:<ITF id>" \
       --from "<the saved file>" \
       --source-url "https://worldtennisnumber.com/eng/player-profile?tennis-id=<ITF id>"
   ```

   **Set both paths absolutely.** A cwd-relative `TN_DB_PATH` silently creates an empty database and
   still reports `status=ok`. A durable script must point at the main checkout
   (`/Users/wrburgess/Projects/aaa/nadal/bin/tn`), never at a worktree — worktrees get pruned and the
   script then fails on every row.

   `wtn-profile:` is its own target. The existing `wtn:` target means the WTN **widget** on the USTA
   page and still does; the two are not interchangeable.

## Verifying the pull landed

```sh
bin/tn player show "<player name>"
```

Expect an `age:` that is a range rather than `unknown`, and a `gender:` that reads `Male` or
`Female` — **not** `Competition Category: MALE`, which was the stored value this work fixed (#130).

To check the whole set at once:

```sh
sqlite3 "$TN_DB_PATH" \
  "SELECT COUNT(*) FROM players WHERE age_range IS NOT NULL AND age_range != '';"
```

## Known limitations

- **Only players with an ITF id can ever get an age range this way.** As of 2026-08-10 that is
  **77 of 1745** players — exactly the 77 that have a gender. The other 1668 keep printing `unknown`
  in every dossier, and that is correct output, not a gap to paper over.
- **One page per player.** There is no bulk endpoint this runbook uses. The GraphQL API the SPA calls
  is undocumented and private; coupling to it was considered and rejected (#128 assessment, option C).
- **The page's CSS class names carry a per-build hash** (`playerDetailsHeader___p1yB3`) that changes
  on every WTN deploy. The parser anchors on the stable prefix, so a deploy alone will not break it —
  but a genuine markup change will, and the parser **fails closed**: it raises rather than writing a
  partial record. If a pull starts refusing after months of working, re-capture a fixture and compare
  before touching the parser.
- **A saved page is a point-in-time copy.** Age range is a slowly-changing fact, but it does change;
  a capture taken before a birthday can be stale in the obvious way.
