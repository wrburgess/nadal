# Published artifacts

The twelve artifacts nadal has published, plus the one assembled site, with what each is and how far
its numbers have been checked against the database.

**Why this file exists.** The artifact gallery is **account-wide, not project-scoped** — the
`Artifact` tool's `list` action takes only `mine` / `shared` / `all`, with no project filter, folder
or tag. A session that calls it sees every artifact the operator owns, including work unrelated to
this repository, and cannot tell which are nadal's. On 2026-08-25 that produced a real error: two
artifacts from other projects were reported as nadal deliverables and one of them was flagged as
possibly carrying a data defect it could not have.

**So: read this file, do not call `Artifact list`, to answer "which artifacts does nadal have?"**
The gallery answers a different question.

## Match cards

One per tie, in playing order. Built by `build_*.py` in the operator's scout-scripts and published to
fixed URLs — republishing keeps the URL, so these links are stable.

| Slot | Artifact | URL | Verified |
|---|---|---|---|
| Fri 11:30 | Friday Morning vs Iowa | https://claude.ai/code/artifact/effc8929-555c-4597-b25d-de143eabefbe | 2026-08-25, cell-by-cell |
| Sat 09:45 | Saturday Morning vs St. Louis | https://claude.ai/code/artifact/e5ff3cee-cf90-47f5-9c12-7a11afc0a074 | 2026-08-25, cell-by-cell |
| Sat 13:15 | Saturday Afternoon vs Oklahoma | https://claude.ai/code/artifact/497b8cb9-3555-49e4-b546-4bf1cfb0374a | 2026-08-25, cell-by-cell |
| Sun 08:15 | Sunday Morning vs Nebraska | https://claude.ai/code/artifact/58d94ac6-862f-47d2-86e8-ff276a17d82d | 2026-08-25, cell-by-cell |

All four were rebuilt on 2026-08-25 after [ISS#176](https://github.com/wrburgess/nadal/issues/176)
was retracted: they had been published carrying twenty inverted courts. Every table row and every
prose number was re-derived from the database. See
[`findings.md`](findings.md) → the 2026-08-25 retraction entry.

## Scouting reports

One per team. Built 2026-08-20, which **predates** the bad corrections table (written 2026-08-25
01:22), so their records were never corrupted.

| Team | URL | Verified |
|---|---|---|
| Iowa | https://claude.ai/code/artifact/6b384566-6c73-4a7a-8659-628fa85ddfbe | spot-check 2026-08-25 — 5 of 5 records matched |
| St. Louis | https://claude.ai/code/artifact/49ce4935-0d76-4514-b6e2-42cff203b6e1 | **not verified** |
| Oklahoma | https://claude.ai/code/artifact/919f1d54-02cc-4fb5-a902-0805fed79983 | **not verified** |
| Nebraska | https://claude.ai/code/artifact/aa4394f2-8736-4260-a08d-56d16158c86e | **not verified** |
| Ourselves (HOA) | https://claude.ai/code/artifact/67ee876a-4f8e-4b23-9ec5-7ccb4fae8c05 | **not verified** |

*Scouting Ourselves* is the HOA self-review; it is easy to miss because its title names no team.

These carry **no WTN column** — `Player · Record · Match win · Game win · Set win · TR`. That matters
because it means the 2026-08-10 WTN rescale cannot have made them stale, a concern that was raised
and then measured away on 2026-08-25.

## Cross-field views

| Artifact | URL | Verified |
|---|---|---|
| Springfield Scouting Board | https://claude.ai/code/artifact/c2ee6076-c7f4-412d-b4a5-59af30f986ab | **not verified** |
| The Springfield Five | https://claude.ai/code/artifact/e9264c28-ba94-4f99-ab32-8f1dcedbc3ff | **not verified** |
| Springfield Handoff | https://claude.ai/code/artifact/2ea11d66-eb0c-4c02-9622-8f172e3db3ca | process doc — not opened |

## The assembled site

Not a gallery artifact — a static site in this repository, served by GitHub Pages.

| Artifact | URL | Verified |
|---|---|---|
| Springfield Game Plan | `https://gameplan.kc.tennis` — **intended, not yet resolving** | access gate exercised 2026-08-25; **numbers not re-derived** |

The URL is what `docs/CNAME` declares, not a address confirmed live: as of this row the `gameplan`
CNAME does not exist at Cloudflare and no certificate has issued. Whoever finds this row stale in
either direction should fix it here.

`docs/index.html`, added by [PR#184](https://github.com/wrburgess/nadal/pull/184). It was assembled
**by hand** from nine of the artifacts above — the four match cards, the five scouting reports, the
Scouting Board and The Springfield Five — plus trip logistics that exist nowhere else. So it is a
*copy*, and the Verified column above is not inherited from its sources: republishing any of those
rows leaves this page stale, and there is no build script to re-derive it.

Two things a reader of this file should know, because they are easy to meet by surprise:

- **Once Pages is enabled, this file is served too** — at `/artifacts.md` on whatever host answers.
  Pages branch-source offers `/` or `/docs` and nothing else, so everything in `docs/` is published,
  `findings.md` included.
- The page carries a four-digit access gate. It is a speed bump, not a control, and it does not
  cover the copies GitHub serves from this public repository. See `findings.md`, 2026-08-25.

## Not nadal

The operator's gallery also holds artifacts from unrelated projects. Two seen on 2026-08-25 —
*Fielders Draft Board* and *Hard Refresh War Room* — are **not** nadal artifacts and share nothing
with this repository's data. Do not report them as nadal deliverables and do not audit them against
this database. If the gallery ever gains project scoping, this section is what it replaces.

## Keeping this current

- Publishing a new nadal artifact, or republishing an existing one, means editing the matching row
  here in the same change.
- The **Verified** column is a claim about numbers, not about design. "cell-by-cell" means every
  record on the page was re-derived from `data/nadal.db` and matched. Anything else is
  **not verified**, and should say so rather than be left blank.
- Prose on the match cards is **hardcoded in the builders** — regenerating a card fixes its tables
  and leaves its sentences stale. A rebuild is not a verification.
