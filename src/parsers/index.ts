/**
 * Source parsers — pure `html -> typed record` functions over captured pages.
 *
 * Nothing here fetches and nothing here writes: Phase 3 (`tn team pull`, `tn player pull`) owns
 * both ends, and keeping the parse step pure is what lets every one of these be tested against a
 * real captured page instead of a live site.
 *
 * Two rules hold across all of them:
 *
 * - **A structural miss throws `ParseError`; an absent optional field is `null`.** "The match
 *   table is gone" and "this player has no singles WTN" are different facts, and collapsing them
 *   into an empty value is how a scouting sheet goes stale while every pull reports success.
 * - **Values are read from located elements, never from page-wide text.** A regex over
 *   `doc.text()` can be satisfied by navigation, a promo block, or another player's card.
 *
 * TennisLink's team, player-history and scorecard parsers are **not** here: every TennisLink
 * league and tournament path now redirects to `account.usta.com` OAuth, so no fixture can be
 * captured without a login-assisted session. See `docs/findings.md` and the tracked follow-up.
 */
export * from "./types.js";
export { parseTennisRecordHeader } from "./tennisrecord/header.js";
export { parseTennisRecordProfile } from "./tennisrecord/profile.js";
export { parseTennisRecordTeam } from "./tennisrecord/team.js";
export { parseMatchHistory } from "./tennisrecord/match-history.js";
export { parseUstaProfile } from "./usta/profile.js";
export { parseWtnWidget } from "./wtn/widget.js";
export { parseWtnProfile } from "./wtn/profile.js";
