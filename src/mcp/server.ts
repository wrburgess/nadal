// The MCP server itself (Task 7, #17) — stdio transport, no Hono (see the PR body / findings note:
// spec § Stack names Hono, but that is only needed for the streamable-HTTP transport, and the
// consumer here is a local agent chat on Randy's laptop talking to a local SQLite file). This module
// wires `src/mcp/tools.ts`'s transport-agnostic table to a real `McpServer`, wrapping every call in
// `logMcpTool` (Task 6) for `surface="mcp"` telemetry.
//
// `createMcpServer()` does NOT open the database — no tool handler runs until a client actually
// calls one — so `db_migrate` can be the first tool called against a brand-new, unmigrated database
// file (`test/mcp-tools.test.ts` asserts this directly).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMcpTool } from "../telemetry/request-log.js";
import { MCP_TOOLS } from "./tools.js";
import { sanitizeJson, sanitizeValue } from "../sanitize.js";

const SERVER_NAME = "tn";
const SERVER_VERSION = "0.1.0";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      async (args) => {
        // The error path stays the SDK's: a handler throw propagates through `logMcpTool` (which
        // logs the `error:<ClassName>` telemetry row and re-throws — Task 6's own contract) to the
        // SDK's own request handler, which converts ANY thrown error into a structured
        // `{ content: [...], isError: true }` result — never an uncaught crash. Building that
        // result here instead would be a second, divergent error-formatting path.
        //
        // What this catch does is narrower: it sanitizes the MESSAGE and rethrows, leaving the
        // conversion to the SDK. Refusal messages quote scraped data — `unknown target "<name>"`,
        // `ambiguous target: <candidates>`, an event name — so the success path's guard below was
        // only half the boundary; a hostile name reached an MCP client simply by failing to
        // resolve. It is placed OUTSIDE `logMcpTool` deliberately, so telemetry still records the
        // original error's real class name before the message is touched.
        // (Found by the independent Codex review of PR #47, rated medium.)
        const result = await logMcpTool(tool.name, args, () => tool.handler(args)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(sanitizeValue(message));
        });
        // Sanitized on the way out, exactly as the CLI's `--json` path is (src/cli/emit.ts):
        // these results carry scraped player and team names, `JSON.stringify` leaves category-Cf
        // characters and U+2028/U+2029 intact, and an MCP client renders this text somewhere a
        // bidi override can reorder it. The CLI and MCP surfaces are the same services behind two
        // transports, so a guard on one and not the other is a hole, not a difference.
        // (Found by the independent Codex review of PR #47, rated medium.)
        return { content: [{ type: "text" as const, text: JSON.stringify(sanitizeJson(result)) }] };
      },
    );
  }

  return server;
}
