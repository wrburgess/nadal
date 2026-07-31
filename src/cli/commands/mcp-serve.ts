import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sanitizeValue } from "../../sanitize.js";
import type { Command } from "../router.js";
import { createMcpServer } from "../../mcp/server.js";

/** The minimal surface this module needs from stdin — narrowed from `NodeJS.ReadableStream` so a
 * test can inject a plain `EventEmitter`-shaped fake rather than a real stream. */
type StdinLike = { once(event: "end", listener: () => void): unknown };

/**
 * Factored out from the registered `mcpServe` command below so a test can inject a lightweight fake
 * `Transport` (and, for the EOF-handling fix below, a fake `stdin`) instead of standing up real
 * stdin/stdout pipes — both default to the real thing for actual use.
 *
 * The returned `Command["run"]` resolves 0 once the transport closes — but the REAL
 * `StdioServerTransport` never calls `onclose` on stdin EOF by itself: it only attaches `'data'`
 * and `'error'` listeners to stdin, confirmed by reading `@modelcontextprotocol/sdk`'s own source
 * (`server/stdio.js`) directly rather than assumed from its types. Verified empirically too: piping
 * a finite script of JSON-RPC messages into a real `tn mcp serve` and letting stdin hit EOF left
 * this function's Promise unsettled forever, and Node exited with **code 13** ("unsettled top-level
 * await") and a scary stderr warning instead of a clean `0` — a real defect, not a hypothetical one,
 * caught by actually running the built command rather than trusting the SDK's stated contract. The
 * fix: this function listens for stdin EOF itself and calls `transport.close()`, which DOES fire
 * `onclose` (that half of the SDK's contract holds) and resolves this Promise cleanly. A client
 * that instead kills the process outright (the common case for a long-running MCP server) never
 * reaches this path at all — the process just ends, same as it always would.
 */
export function createMcpServeRunner(
  createTransport: () => Transport = () => new StdioServerTransport(),
  stdin: StdinLike = process.stdin,
): Command["run"] {
  return async (args) => {
    // `mcp serve` takes NO arguments. It is the one command that cannot honor the global flags:
    // its stdout IS the JSON-RPC stream, so a `--json` payload or a `--quiet`-suppressed summary
    // line are both meaningless here, and writing either would corrupt the protocol.
    //
    // Rejecting rather than ignoring is the point. `dispatch` hands trailing argv to every
    // command, and this runner previously ignored it entirely — so `tn mcp serve --jsno` silently
    // started the server instead of surfacing the typo, while GRAMMAR.md promised every command
    // accepts the global flags and rejects undeclared ones. That promise is now true by
    // construction here rather than exempted in prose: an unrecognized flag is very likely a
    // typo'd real one (src/cli/args.ts's own stated stance), and silently accepting it makes the
    // typo invisible. `--help` never reaches this path — `dispatch` handles it first.
    // Found by the independent reviewer in round 4 of #17 PR A.
    if (args.length > 0) {
      console.error(
        `error: tn mcp serve takes no arguments (got ${args.map(sanitizeValue).join(" ")}). Run tn mcp serve --help`,
      );
      return 1;
    }
    const server = createMcpServer();
    const transport = createTransport();
    return new Promise<number>((resolve, reject) => {
      transport.onclose = () => resolve(0);
      transport.onerror = (err) => reject(err);
      server.connect(transport).catch(reject);
      stdin.once("end", () => {
        transport.close().catch(reject);
      });
    });
  };
}

/**
 * `tn mcp serve` (Task 7, #17) — a registered command like any other, so it appears in `GRAMMAR.md`,
 * gets a help row, and needs no second `bin` entry (spec § Interfaces: "Same services; tool names
 * mirror the grammar"). Takes no target/flags of its own; `--help` is handled globally by
 * `dispatch()` before any command's `run` is reached.
 */
export const mcpServe: Command = {
  noun: "mcp",
  verb: "serve",
  summary: "Run the MCP server over stdio, mirroring the CLI grammar as tools",
  run: createMcpServeRunner(),
};
