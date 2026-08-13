import { emitSummary } from "./emit.js";
import { errorClass, errorMessage } from "../error-message.js";

/**
 * Reports an error a CLI command THREW rather than handled — issue #160.
 *
 * The defect this closes: `logRequest` (src/telemetry/request-log.ts) wrapped every dispatched
 * command, caught anything thrown, used it to label a telemetry row, and then discarded it. `tn`
 * exited 1 with nothing on stdout or stderr. Found live on 2026-08-13 against a production
 * database one migration behind `main`, where every command reading `players` through the ORM
 * threw `SqliteError` and said nothing; recorded once BEFORE that, in a comment at
 * `src/cli/commands/db-migrate.ts:36-39`, where #64 observed the same swallowing and patched the
 * one command instead of the class.
 *
 * Why the reporting lives HERE and not in `logRequest`'s module: `logRequest` holds a deliberate,
 * reviewed guarantee — telemetry must never break the command it wraps (PR #84 finding 3, pinned by
 * `test/request-log.test.ts:147`, where a throwing classifier made `logRequest` reject and the
 * wrapped call's exit code never came back). That guarantee is correct. The bug was that it was
 * applied to the WRONG error: the command's own failure was swallowed with the discipline
 * telemetry owes only its own machinery. So the fix is not to make `logRequest` propagate — it is
 * to make it SPEAK before it returns. Only the call sits at the catch site; the decision about what
 * a human sees lives in this file.
 *
 * Built on `errorMessage`/`errorClass` (src/error-message.ts) rather than `err.message` /
 * `err.constructor.name` because this function runs INSIDE a catch, where a hostile value that
 * makes the reporter throw would replace the operator's real error with the reporter's own — the
 * #64 shape exactly. Both helpers are hardened against that and cannot throw.
 *
 * `emitSummary` does the rest and is not re-implemented: it already routes any non-"ok" status to
 * stderr, sanitizes through `quoteSummaryValue`, honors `--json`, and deliberately does NOT let
 * `--quiet` suppress an error line. That last one matters here more than anywhere — a failure the
 * operator cannot see is the whole defect.
 */
export function reportFatal(
  command: string,
  err: unknown,
  opts: { json: boolean; quiet: boolean },
): void {
  emitSummary(
    command,
    "error",
    [
      ["message", errorMessage(err)],
      ["class", errorClass(err)],
    ],
    opts,
  );
}
