# Runbook: capture a test fixture from a live page

## When to use this

A parser is only as good as the page it was tested against — spec § _Testing_ requires parsers to run
against **raw captured pages** with hand-verified expected values, never against invented markup. So
whenever a new parser is needed, or a site changes shape under an existing one, someone has to turn a
real page into a committed fixture.

That procedure existed before this runbook, but only inside
[`test/fixtures/README.md`](../../test/fixtures/README.md) § _Re-capturing_ — contributor
documentation, written for someone already in the code. This runbook is the **operator-facing** version:
what the HC does, what the agent does, and where the session actually stalls.

Two variants, and the second is where the work is:

- **Public page** (TennisRecord) — the agent can do the whole thing alone. No HC step.
- **Login-assisted page** (USTA player-search, TennisLink) — the page only exists behind a signed-in
  session, so the HC drives the browser. This is spec § _Operating loop_, HC step 2.

For a _production pull_ from a logged-in page — not a fixture — use
[login-assisted-scrape.md](login-assisted-scrape.md) instead. Same login, different destination: that
one ends at `tn player pull`, this one ends at a committed file in `test/fixtures/`.

## Before you start

- **The substitution map is required and is never committed.** It maps each real identity to its
  synthetic stand-in, and it lives **outside the repo**. Without `--map`, there is no capture.
- **Know which detector set you need.** `tools/capture-fixture.ts` ships `tennisrecord`, `usta`, and
  `none`. A new source needs a new set — see _Adding a detector set for a new source_ below, and note
  that it must be written **from the real markup**, so it is authored _during_ this session, not before.
- **`none` refuses by default, on purpose.** It resolves no vocabulary file, and the tool will not
  write a fixture without one.

## Steps — login-assisted capture

1. **HC: sign in.** In a normal browser, log into `account.usta.com`. For TennisLink specifically,
   confirm the session took by loading `tennislink.usta.com/leagues/Main/StatsAndStandings.aspx` — a
   signed-out session bounces to `Dashboard/Main/Login.aspx` and on to
   `account.usta.com/authorize?...&audience=tennislink`.

2. **HC: navigate to each page you want captured, and copy the URL from the address bar.**

   > **This step is the HC's and does not delegate — on TennisLink it is not merely more convenient,
   > it is the only thing that works.** Its league team and player links are `javascript:` hrefs rather
   > than real URLs, so an automation harness cannot click them; the search form is ASP.NET WebForms,
   > whose postback re-renders from server state and discards scripted field values; and a browser
   > extension will generally refuse to hand back bulk query-string data, so links cannot be harvested
   > and replayed either. A human clicks through in seconds. Do not spend a session re-discovering this
   > (`docs/findings.md`, 2026-08-01).

   The URL matters as much as the page. It is recorded in the provenance sidecar, several parsers read
   ids **only** from it, and `test/helpers/fixtures.ts` refuses to load a fixture that has no
   provenance. **Copy it literally, including any `#fragment`** — the USTA profile's `uaid` lives
   nowhere else.

   > **An opaque token in the URL is _examined_, but not _understood_.** TennisLink's league pages
   > address themselves as `StatsAndStandings.aspx?SearchType=3#&&s=<33-char opaque token>` — the
   > entity reference lives in that token and nowhere else, so it cannot simply be dropped from the
   > provenance.
   >
   > The good news, and it is easy to overstate the gap here: `capture-fixture.ts` runs the
   > `sourceUrl` through `redact()` **with the vocabulary**, so the allow-list inspects it as content
   > like any other atom. An unrecognised token therefore **refuses the capture** rather than shipping
   > — the boundary holds.
   >
   > What is missing is a _credential-specific_ classifier: nothing can tell you whether that token is
   > an entity key or session state. So the refusal lands you in the loop of step 6, where the
   > tempting move is to make it go away by adding the token to the vocabulary. **Do not.** If the
   > token is session-bound, that publishes it. **Before committing the first TennisLink fixture,
   > establish which it is** — the cheap test is whether the same URL resolves from a different
   > session. Until then, treat it as a credential.

3. **HC: save the post-render DOM.** "Save Page As… → **Webpage, Complete**". For any client-rendered
   page (the USTA profile SPA, its WTN widget), wait for the content to actually appear first — a page
   saved mid-render parses as a structural miss, which is the single most common cause of a failed
   capture. Save outside the repo, next to the map.

4. **Agent: author the detector set and vocabulary from what the page actually contains** — the section
   below. Skip only when capturing from a source that already has both.

5. **Agent: run the capture.**

   ```sh
   tsx tools/capture-fixture.ts \
       --file <the saved page> \
       --source-url "<the exact URL from step 2>" \
       --map <the map, outside the repo> \
       --detectors <set> \
       --out test/fixtures/<source>/<name>.html
   ```

   Use `--file`/`--source-url` for a saved page; `--url` fetches directly and is for public pages only.

6. **Agent: work the refusal loop — expect several rounds, and do not shortcut it.** The allow-list
   policy refuses on any content atom it cannot classify, reports **every** unclassified skeleton (not
   just the first), and writes nothing. For each one, decide honestly which it is:
   - structural, boilerplate, or UI chrome → `# reviewed: <reason>`
   - a real public name — a club, league, section, venue → `# reviewed: <reason>`
   - a genuine invented stand-in → `# reviewed[synthetic]: <reason>`, which `loadVocabulary()`
     machine-checks against `tools/fixture-vocabulary/stand-ins.txt` and will refuse if the tokens are
     not really synthetic

   Add each to the committed vocabulary file and re-run. `tools/bootstrap-vocabulary.ts` auto-writes the
   non-name-shaped ones; **every name-shaped skeleton is dispositioned by hand.** On a page dense with
   people — a scorecard naming ten players across five courts — this is the longest part of the session.

7. **Agent: read the redacted fixture before committing it. A green pipeline is not sufficient.**

   > ### ⚠️ Session credentials are NOT stripped for you
   >
   > **This step is manual, and on a login-gated page it is the one that matters most.**
   >
   > **Nothing in this repository removes a session credential from a captured page.** A control to do
   > it was attempted and withdrawn — see [#80](https://github.com/wrburgess/nadal/issues/80) for why,
   > and do not assume a later reader has landed it. Check `tools/redact-fixture.ts` yourself before
   > relying on any automation here.
   >
   > This is not theoretical. A real signed-in TennisLink league page carries a **172-character
   > `hdnCSRFToken`** and a **14,420-character `__VIEWSTATE`** inline in the markup, both live session
   > state belonging to _you_, the capturing operator — not to the page's subject, and therefore in no
   > substitution map built from scouting targets.
   >
   > **Before committing any fixture captured from a signed-in session, grep the redacted output for:**
   >
   > ```sh
   > grep -oiE '(__VIEWSTATE|__EVENTVALIDATION|__RequestVerificationToken|authenticity_token|_token|csrfmiddlewaretoken|csrf|xsrf)[^>]{0,40}' <fixture>
   > ```
   >
   > **A hit is a candidate, not a verdict — read each one before deleting anything.** The grep matches
   > a _field name_, and a matching name does not prove the value is a credential. Two rules before you
   > edit:
   >
   > - **Skip `type=submit|button|reset|image`.** Their `value` is the control's **visible label**, never
   >   a credential. This is not hypothetical: TennisLink ships
   >   `<input type="submit" id="btnCsrfRefreshPage" value="Refresh Page">`, which matches on `csrf` and
   >   whose value is the words on the button. Deleting it corrupts the page for no privacy gain — the
   >   same false positive the withdrawn automation hit before it was withdrawn (#80).
   > - **Empty the credential-bearing attribute only** — `value` on an `<input>`, `content` on a
   >   `<meta>` — and leave the element, its `name`/`id` and every other attribute alone.
   >
   > Then re-run the capture checks. And do not stop at that list: it is the conventions of frameworks
   > this project has met, not a complete set.
   >
   > **And never resolve an allow-list refusal by adding a long opaque string to the vocabulary.** That
   > is the specific mistake this warning exists to prevent: the allow-list _will_ refuse a
   > 172-character token, and the documented remedy for a refusal is to classify the atom and commit it
   > — which would publish the token. If a refusal shows you something opaque and high-entropy, treat
   > it as a credential, not as boilerplate.

   **What is still yours to check.** `tools/fixture-policy.ts` documents that **bare digit runs of any
   length are admitted structurally**, so a purely numeric identifier reduces to an empty skeleton and
   ships silently. On a login-gated page that is not hypothetical: TennisLink renders the **signed-in
   operator's own name and 10-digit USTA Account #** in page chrome on every page, and the operator is
   not a scouting subject, so a map built from the pages' subjects will not contain them. Grep the
   output for the account number, the operator's surname, and any `PersonID` / `MemberNum` / `PlayerID` /
   `t=` value before it goes into git.

8. **Agent: commit the fixture, its `.provenance.json` sidecar, and the vocabulary changes**, and
   register the fixture in `test/fixtures-vocabulary-complete.test.ts`'s `FIXTURES` list — the CI gate
   that re-runs the policy over every committed fixture. A fixture missing from that array is a fixture
   nothing re-checks.

## Adding a detector set for a new source

Detectors are the structural sweep that catches an identity **the substitution map forgot** — they read
what the site advertises in its own markup, so they are the layer that does not depend on someone
having remembered a name.

Add a key to `DETECTOR_SETS` in `tools/capture-fixture.ts`, plus a committed
`tools/fixture-vocabulary/<set>.txt`.

**Then widen the CI gate's source union, or step 8 cannot be completed.**
`test/fixtures-vocabulary-complete.test.ts` declares
`const FIXTURES: { source: "tennisrecord" | "usta"; name: string }[]` — a closed union, so a
fixture from a newly-named source **cannot be registered** until that type admits it. Widen the
union (or derive it from `DETECTOR_SETS`) as part of adding the set, not as a surprise at
registration time.

Two further constraints, both learned the hard way:

- **Id sweeps alone are not enough.** On the USTA capture, every id matched and was replaced, both
  sweeps passed — and the player's rendered _display name_ shipped anyway. A set needs a detector for
  **what a human reading the page would recognise**, not only for what looks like an identifier
  (`tools/capture-fixture.ts`, provenance: PR #26 adversarial review round 3).
- **Stop id patterns at `&` or a quote, never at whitespace.** A query-param value can legitimately
  contain a literal space (`teamname=Surname%2c First`); stopping at whitespace truncates the surname
  away and lets the sweep pass on a first name it never recognised.

**Write them from the markup in front of you.** A detector set authored before anyone has seen the page
fails _quietly_ — nothing leaks, because the allow-list still refuses unknown atoms, but the sweep
under-covers while appearing to pass, which is the exact failure mode above.

## Verifying the capture landed

- `npm test -- test/fixtures-vocabulary-complete.test.ts` — the policy re-runs over every committed
  fixture, including the new one.
- The parser's own test loads it through `loadFixture(...)`, which throws if the provenance sidecar
  is **missing or not valid JSON**. Note the limit: it `JSON.parse`s and casts, and does **not**
  validate the fields — a sidecar with a missing, empty or wrong-typed `sourceUrl`/`fetchedAt` is
  accepted, and the parser then receives invalid provenance. Check those two fields by eye.
- Reopen the committed fixture and confirm it is the complete rendered page, not a partial or an error
  state — a saved "Record not found" page is still valid HTML and will redact cleanly.

## Known limitations

- **The map never enters the repo**, so a capture cannot be reproduced from a clean clone. That is the
  intended trade-off: reproducibility of the _fixture_ comes from committing the redacted output, not
  from being able to re-derive it.
- **Numeric identifiers are not constrained by the allow-list** (step 7). The detector sweep is what
  covers them, which is why a new source needs its own set rather than borrowing `none`.
- **No automated login, in either direction.** Nothing here logs in, and nothing detects that a session
  expired mid-session except a saved page that turns out to be a login redirect.
