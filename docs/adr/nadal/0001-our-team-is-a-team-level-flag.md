# "Our team" is a team-level flag, not a per-event or config designation

**Status:** accepted

## Context

Nothing in nadal designates an own team (#37): dossier assembly renders "prior meetings vs our
players" as unavailable (spec § Deliverables #1), and Availability/CaptainNote are both, per spec §
Domain model, "populated for our team only, by design" with no way to know which team that is. #17's
assessment named three shapes: a per-event designation, a config value/env var, or a team-level flag.

- **Per-event designation** would model a distinction that does not exist in this domain. What
  legitimately varies per event is the **roster** (`team_memberships.event_id` already carries that)
  and the **format** (`events.format`) — never *which team is Randy's*. Burgess-Zingg does not become
  someone else's team at a different event, and a per-event join would run on every dossier read to
  answer a question with exactly one answer.
- **Config value / env var** is what #37 itself argues against: "our team" is read by dossier
  assembly, availability, and captain notes — a domain fact queried alongside other domain facts, not
  a deployment-path setting like `TN_DB_PATH`.
- **Team-level flag** — `teams.is_home` — is the honest v1 model: a fact about one row in `teams`,
  read the same way any other team attribute is read.

## Decision

`teams.is_home`: a nullable boolean column, with **at most one `true` row enforced by a partial
unique index** (`CREATE UNIQUE INDEX team_home_unique ON teams (is_home) WHERE is_home = 1`) rather
than by application code alone. Two rows flagged at once is exactly the class of defect
docs/findings.md keeps finding (`rules/backend.md`: "a validation is not a guarantee under
concurrency"), so the database — not just `src/query/home-team.ts`'s `setHomeTeam` — is the thing
that actually guarantees the invariant. `setHomeTeam` clears any prior designation and sets the new
one inside a single transaction so the index never observes two set rows, even transiently.

**Forward path if this is ever wrong:** a future `events.own_team_id` override column, defaulting to
whatever `teams.is_home` resolves to when unset — an addition, not a reversal of this decision.

## Considered options

- Per-event designation — rejected: models a distinction (which team is "ours") that does not
  actually vary per event in this domain; adds an unnecessary join to every dossier read.
- Config value / env var — rejected: "our team" is queried alongside other domain facts by three
  different call sites (dossiers, availability, captain notes), not read once at process start like a
  deployment path.
- Team-level flag (chosen) — the domain fact lives where the domain data lives, enforced at the
  database layer rather than trusted to application code.
