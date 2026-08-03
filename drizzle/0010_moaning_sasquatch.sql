-- Issue #62: `nameKey` (src/db/name-key.ts) changed fold — it now strips category-Cf format
-- characters and normalizes NFKC rather than NFC. Every `name_key` written under the OLD fold is
-- therefore stale: non-null, wrong, and detected by nothing. `backfillNameKeys` only fills keys
-- that are NULL, and the fail-closed probe in src/ingest/identity.ts only refuses on NULL, so a
-- stale key is silently trusted by the tier-2 exact lookup, which then misses.
--
-- Measured, not assumed (test/db-name-key-refold-upgrade.test.ts): a stale key is NOT reliably
-- caught by the fuzzy tier either. Tier 3 pre-filters candidates on `name_key_length` within
-- ±FUZZY_MAX_DISTANCE, and a key holding three stripped characters is 3 longer than the target's
-- new key — outside the band — so the row is never a candidate and the ladder creates a duplicate
-- SILENTLY. That is precisely the defect #62 closes, reintroduced by the fix for it.
--
-- Setting the keys to NULL hands them to `backfillNameKeys`, which `runMigrations` already calls
-- immediately after `migrate()` (src/db/client.ts) and which re-derives each key in JS from the
-- source name. The fold must stay in JS — SQLite's `lower()` is ASCII-only and it has no NFKC — so
-- this migration cannot recompute the keys itself, and deliberately does not try.
--
-- Derived data only: `canonical_name` / `alias` / `name` are untouched, so this is fully reversible
-- by re-deriving. `name_key_length` is GENERATED ALWAYS AS (length(name_key)) VIRTUAL on `players`
-- and `teams`, so it and its indexes follow automatically and need no statement here.
--
-- Interrupted between these UPDATEs and the backfill, the DB is left with NULL keys and this
-- migration will not re-run (the journal records it). Recovery is `tn db migrate` again:
-- `backfillNameKeys` runs unconditionally and re-keys them. Until then the probe REFUSES rather
-- than resolving, so the window fails closed. Covered by the SAD PATH case in that test file.
UPDATE `players` SET `name_key` = NULL;--> statement-breakpoint
UPDATE `player_aliases` SET `name_key` = NULL;--> statement-breakpoint
UPDATE `teams` SET `name_key` = NULL;
