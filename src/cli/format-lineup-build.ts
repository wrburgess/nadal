// Terminal rendering for `tn lineup build` (#127) — the sibling of `format-lineup.ts`, kept beside
// it and separate from `src/report/*.ts` for the reason that module states: a terminal and a printed
// binder are different audiences over the same `src/query/` shapes.
//
// The rule THIS module exists to enforce is one step harder than its sibling's. `tn lineup plan`
// renders a guess and has to keep saying so; this renders a lineup a captain may actually field, so
// it cannot hide behind a disclaimer. What it must do instead is **show the choice**: every
// placement carries the evidence it rests on, everyone who is not playing is named along with WHY
// (three distinct absences, never one), each strategy states the rule it ran, and two strategies
// that agreed are printed ONCE rather than posing as two options. Every line below is asserted
// individually in `test/cli-lineup-build-command.test.ts` — none of it is decoration.
//
// Three shape distinctions this presenter is the last place to get right, all of them easy to
// collapse and all of them load-bearing:
//
//   1. `shortfall` counts BODIES; a scenario's `unfilledSeats` counts SEATS. One body short of a
//      doubles court is `shortfall: 1` and `unfilledSeats: 2`, with that body sitting. Both numbers
//      are printed, on their own lines, because a captain hunting for one more player and a captain
//      looking at an empty court are asking different questions.
//   2. `courtRating` is printed; `courtStrength` NEVER is. The latter is direction-normalized and
//      goes negative on the WTN scales — it exists so the orderings can say "higher is stronger" on
//      every scale, and a negative WTN on the page would teach a reader something false.
//   3. `sharedMatches === 0` means *no shared history* and is printed as such; `null` means the
//      question does not arise (a singles court, or an unfilled one) and prints nothing. Rendering
//      `null` as "0" would invent an observation about a court nobody is standing on.
//
// Pure: no `db`, no clock, one `LineupBuild` in and one string out.

import { STRATEGY_RULES } from "../query/derive-lineup-build.js";
import type { LedgerPlayer, ScenarioCourt } from "../query/derive-lineup-build.js";
import type { LineupBuild } from "../query/lineup-build.js";
import type { RatingSource } from "../query/types.js";
import { formatName, formatRatingValue, formatRosterSourceLine, ratingSourceLabel } from "./format-profile.js";

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function courtMatchCount(n: number): string {
  return `${n} court match${n === 1 ? "" : "es"}`;
}

/** Names, comma-joined and sanitized — or `empty` when there are none. The empty case is a WORD, not
 * a blank: a bucket with nobody in it is a fact about the day, and a page that rendered it as
 * trailing whitespace would read as a rendering bug instead. */
function nameList(people: LedgerPlayer[], empty: string): string {
  if (people.length === 0) return empty;
  return people.map((p) => formatName(p.canonicalName)).join(", ");
}

/**
 * The players cell for one court, sanitized.
 *
 * An EMPTY court is spelled out rather than left blank, and it names how many seats went unused —
 * `derive-lineup-build.ts` fills a doubles court with two bodies or with none, never with one, so an
 * empty court is always the whole court.
 */
function courtPlayersCell(court: ScenarioCourt): string {
  if (court.players.length === 0) {
    return `(unfilled — ${court.seats} ${plural(court.seats, "seat", "seats")}, nobody eligible left)`;
  }
  return court.players.map((p) => formatName(p.canonicalName)).join(" / ");
}

/** The court's rating, RAW, in the scale named on the page — see distinction 2 in the module note. */
function courtRatingCell(court: ScenarioCourt, source: RatingSource | null): string {
  // These two conditions are ONE state seen from two sides: a court carries a sum only when somebody
  // on it is rated, which cannot happen when no scale was chosen at all. They are written as a pair
  // because the compiler narrows each name separately, not because either can occur without the
  // other — no fixture can distinguish them.
  if (court.courtRating === null || source === null) return "unrated";
  const value = `${ratingSourceLabel(source)} ${formatRatingValue(court.courtRating, source)}`;
  // A partly-rated court is legible as partly rated rather than as weak.
  return court.ratedPlayers < court.players.length
    ? `${value} (${court.ratedPlayers} of ${court.players.length} rated)`
    : value;
}

/** Shared history for one court — see distinction 3 in the module note. */
function sharedMatchesCell(court: ScenarioCourt): string {
  if (court.sharedMatches === null) return "";
  if (court.sharedMatches === 0) return "no shared history";
  return `${court.sharedMatches} ${plural(court.sharedMatches, "match", "matches")} together`;
}

export function formatLineupBuild(build: LineupBuild): string {
  const lines: string[] = [
    `LINEUP BUILD — ${build.day} — ${formatName(build.teamName)}`,
    `  event "${formatName(build.event.name)}"`,
    "",
  ];

  // The eligibility ledger. All four buckets ALWAYS print, empty or not, and each has its own
  // wording: `unavailable`, `uncertain` and "never answered" are three different states, a captain
  // chases them three different ways, and a page that folded the last two into "not available" would
  // be hiding the only two that a phone call can still change.
  const { ledger } = build;
  lines.push(
    `  available (${ledger.available.length}) — eligible to field today: ${nameList(ledger.available, "none")}`,
    `  unavailable (${ledger.unavailable.length}) — said no, not fielded: ${nameList(ledger.unavailable, "none")}`,
    `  uncertain (${ledger.uncertain.length}) — said maybe, not fielded: ${nameList(ledger.uncertain, "none")}`,
    `  no answer on file (${ledger.unrecorded.length}) — nobody recorded an answer, not fielded: ` +
      nameList(ledger.unrecorded, "none"),
    "",
  );

  const slotList = build.slotSet.map((court) => `${formatName(court.slot)} (${court.discipline})`).join(", ");
  lines.push(
    `  courts (${build.slotSet.length}): ${slotList}`,
    `  bodies needed: ${build.bodiesNeeded} — eligible today: ${build.eligibleCount}`,
  );
  if (build.shortfall > 0) {
    lines.push(
      `  shortfall: ${build.shortfall} ${plural(build.shortfall, "body", "bodies")} short of the ` +
        `${build.bodiesNeeded} this court list needs — a court is left unfilled rather than ` +
        "double-booking anyone",
    );
  }

  // ONE column layout for the whole page, measured across every scenario's courts rather than
  // re-measured per table — two tables of the same courts that did not line up with each other would
  // be harder to compare than one wide table, which is the whole reason they are stacked.
  //
  // Measured on the SANITIZED cell, never the raw one: a control or format character costs a column
  // in the string and none on screen, so a width taken before sanitizing lays the page out against a
  // number nobody can see. An empty court is excluded from the measurement on purpose — its cell is
  // a whole sentence and carries no trailing column to align.
  const cells = build.scenarios.flatMap((scenario) =>
    scenario.courts.filter((court) => court.players.length > 0).map((court) => courtPlayersCell(court).length),
  );
  const nameWidth = Math.max(1, ...cells);
  const slotWidth = Math.max(1, ...build.slotSet.map((court) => formatName(court.slot).length));

  const strategiesRun = build.scenarios.reduce((total, scenario) => total + scenario.strategies.length, 0);
  lines.push(
    "",
    `  scenarios: ${build.scenarios.length} distinct ${plural(build.scenarios.length, "lineup", "lineups")} ` +
      `from ${strategiesRun} strategies`,
  );

  build.scenarios.forEach((scenario, index) => {
    lines.push("", `  SCENARIO ${index + 1} — ${scenario.strategies.join(", ")}`);
    // MORE THAN ONE NAME IS THE COLLAPSE. These strategies produced identical court assignments, so
    // the table is printed once under all of them — three identical tables must never read as three
    // options, and the degenerate case is real (nothing rated and nothing played collapses all
    // three). The sentence says so out loud rather than leaving a reader to notice the comma.
    if (scenario.strategies.length > 1) {
      lines.push(
        `    (these ${scenario.strategies.length} strategies produced the same lineup — printed once, ` +
          `not as ${scenario.strategies.length} options)`,
      );
    }
    // Each rule VERBATIM from the exported `STRATEGY_RULES`, never paraphrased here: the export
    // exists so the page states the rule the code actually ran.
    for (const strategy of scenario.strategies) {
      lines.push(`    rule (${strategy}): ${STRATEGY_RULES[strategy]}`);
    }

    for (const court of scenario.courts) {
      const cell = courtPlayersCell(court);
      const evidence =
        court.players.length === 0
          ? ""
          : [courtRatingCell(court, build.ratingSource), sharedMatchesCell(court)]
              .filter((part) => part !== "")
              .join("   ");
      lines.push(
        `    ${formatName(court.slot).padEnd(slotWidth)}  ${cell.padEnd(nameWidth)}  ${evidence}`.trimEnd(),
      );
    }

    if (scenario.unfilledSlots.length > 0) {
      lines.push(
        `    short: ${scenario.unfilledSlots.map(formatName).join(", ")} unfilled — ` +
          `${scenario.unfilledSeats} ${plural(scenario.unfilledSeats, "seat", "seats")} empty`,
      );
    }
    // Printed with the same weight as who plays: an available player who is not fielded is a
    // decision, and a page that only listed the winners would be hiding it.
    lines.push(`    sitting: ${nameList(scenario.sitting, "nobody")}`);
  });

  lines.push("");
  lines.push(
    build.ratingSource === null
      ? // Byte-identical to the sentence `format-lineup.ts` prints for this state. One wording for
        // one fact: a reader meeting it on both lineup pages should not have to work out whether the
        // two mean the same thing.
        "  ratings: none on file — every tie fell through to a stable ordering, not to strength"
      : `  ratings: ranked within ${ratingSourceLabel(build.ratingSource)} ` +
        `(rated: ${build.ratedEligible} of ${build.eligibleCount} eligible)`,
  );
  // #113's roster-source disclosure. The event name is always non-null here — this command resolves
  // an event from the day before anything else — so the season branch reads "season roster (event
  // "X") — no registered members", which is the informative half of that sentence rather than the
  // "no event named" one.
  lines.push(
    `  roster: ${formatRosterSourceLine(
      build.rosterSource,
      build.event.name,
      build.registeredCount,
      build.seasonCount,
    )}`,
  );
  // Always printed, both branches, including a zero (#97's discipline): every shared-match count on
  // this page rests on this number, and a zero that is not stated reads as missing data rather than
  // as a correctly-scoped absence of history.
  lines.push(`  evidence: ${courtMatchCount(build.observedCourtMatches)} of this team's own across this roster`);
  // Only when there is something to say — without it, a build whose players have played hundreds of
  // matches elsewhere looks like a database that was never pulled.
  if (build.excludedOtherTeamMatches > 0) {
    lines.push(
      `  excluded: ${courtMatchCount(build.excludedOtherTeamMatches)} these players played for other teams`,
    );
  }

  // Captain notes: DISPLAYED, NEVER SCORED — no strategy above read one, and the line says so, so a
  // reader cannot mistake a note beside a court for the reason that court was chosen.
  //
  // Filtered to notes whose every named player is placed somewhere in this build. A note about a
  // pairing only bears on today's decision if both partners can actually be fielded; one about
  // somebody who said no is context for another day. What is withheld is COUNTED rather than
  // silently dropped, so the page never implies a captain's journal is empty when it is not.
  const placed = new Set(
    build.scenarios.flatMap((scenario) => scenario.courts.flatMap((court) => court.players.map((p) => p.playerId))),
  );
  const playerNotes = build.captainNotes.player.filter((note) => placed.has(note.playerId));
  const pairingNotes = build.captainNotes.pairing.filter(
    (note) => placed.has(note.playerId) && placed.has(note.pairPlayerId),
  );
  const withheld =
    build.captainNotes.player.length -
    playerNotes.length +
    (build.captainNotes.pairing.length - pairingNotes.length);
  if (playerNotes.length + pairingNotes.length > 0) {
    lines.push("", "  captain notes on placed players:");
    for (const note of playerNotes) {
      lines.push(`    ${formatName(note.canonicalName)}: ${formatName(note.note)}`);
    }
    for (const note of pairingNotes) {
      lines.push(
        `    ${formatName(note.canonicalName)} + ${formatName(note.pairCanonicalName)}: ${formatName(note.note)}`,
      );
    }
    lines.push("    (displayed, never scored — no strategy above used them)");
  }
  if (withheld > 0) {
    lines.push(`  captain notes: ${withheld} more on file about players not placed today`);
  }

  // The two standing limits, printed on every run rather than kept in the docs. Both are things a
  // reader would otherwise reasonably assume the opposite of, and both are v1 scope decisions rather
  // than bugs — which is exactly why they belong on the page instead of in a closed issue.
  lines.push(
    "",
    "  limit: the event's court list is one list for all its days — nadal stores no per-day court set",
    "  limit: deliberate double-duty (one player on two courts) is out of scope for v1",
  );

  return lines.join("\n");
}
