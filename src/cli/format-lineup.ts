// Terminal rendering for `tn lineup plan` (#17 PR B). Kept beside `format-profile.ts` and separate
// from `src/report/*.ts` for the same reason that module states: a terminal and a printed binder
// are different audiences over the same `src/query/` shapes, and should stay free to diverge.
//
// The one rule this module exists to enforce: **the output must keep saying it is a guess.** Spec §
// Deliverables 1 asks for "a predicted lineup honestly labeled a guess", and the single largest
// risk in the whole feature is a plausible-looking table being read as fact. So the header carries
// the word, every slot carries its confidence and basis, the rating scale and the slot set's
// provenance are named, and anyone left over is listed. None of that is decoration — each line is
// asserted in `test/cli-lineup-plan-command.test.ts`.

import { ratingSourceLabel } from "./format-profile.js";
import type { LineupPlan, LineupPlanSlot } from "../query/lineup.js";

/** `basis` and `confidence` answer different questions, so both are printed: "low" from two shared
 * matches and "low" from no shared matches at all are not the same claim. */
function slotEvidence(slot: LineupPlanSlot): string {
  // `slot.confidence`, never a hardcoded "low" — a rating placement always carries support 0 and
  // therefore reads low today, but writing the literal here would let this presenter disagree with
  // the `--json` output and the dossier the moment that stopped being true.
  const confidence = `conf: ${slot.confidence.padEnd(6)}`;
  if (slot.basis === "rating") return `${confidence}  placed by rating — no shared history`;
  const noun =
    slot.discipline === "singles"
      ? `singles match${slot.support === 1 ? "" : "es"}`
      : `match${slot.support === 1 ? "" : "es"} together`;
  return `${confidence}  ${slot.support} ${noun}`;
}

export function formatLineupPlan(plan: LineupPlan): string {
  const lines = [
    `PREDICTED LINEUP — ${plan.teamName}`,
    `  This is a guess, not a lineup card. Based on ${plan.observedCourtMatches} observed court ` +
      `match${plan.observedCourtMatches === 1 ? "" : "es"} across a roster of ${plan.rosterSize}.`,
    "",
  ];

  const nameWidth = Math.max(
    1,
    ...plan.slots.flatMap((s) => s.players.map((p) => p.canonicalName.length)),
  );

  for (const slot of plan.slots) {
    if (slot.players.length === 0) {
      lines.push(`  ${slot.slot.padEnd(4)} ${"(unfilled — roster exhausted)".padEnd(nameWidth)}`);
      continue;
    }
    const evidence = slotEvidence(slot);
    slot.players.forEach((player, index) => {
      const label = index === 0 ? slot.slot.padEnd(4) : "    ";
      const trailer = index === 0 ? `  ${evidence}` : "";
      lines.push(`  ${label} ${player.canonicalName.padEnd(nameWidth)}${trailer}`.trimEnd());
    });
  }

  lines.push("");
  if (plan.unplaced.length > 0) {
    lines.push(
      `  not placed: ${plan.unplaced
        .map((p) => `${p.canonicalName} (${p.courtMatches} court match${p.courtMatches === 1 ? "" : "es"})`)
        .join(", ")}`,
    );
  }

  lines.push(
    plan.ratingSource === null
      ? "  ratings: none on file — every tie fell through to a stable ordering, not to strength"
      : `  ratings: ranked within ${ratingSourceLabel(plan.ratingSource)}` +
        (plan.unranked.length === 0
          ? ""
          : `; unrated: ${plan.unranked.map((p) => p.canonicalName).join(", ")}`),
  );
  // Named on every run, because it is the standing limitation of the v1 rule: the courts predicted
  // are the courts this team has been SEEN to field, which may not be the courts the event fields.
  lines.push(`  courts: ${plan.slots.length}, from this team's observed match history (not the event format)`);

  return lines.join("\n");
}
