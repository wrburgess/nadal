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
import { sanitizeJson } from "../sanitize.js";

const SERVER_NAME = "tn";
const SERVER_VERSION = "0.1.0";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      async (args) => {
        // Deliberately no try/catch here: a handler throw propagates through `logMcpTool` (which
        // logs the `error:<ClassName>` telemetry row and re-throws — Task 6's own contract) to the
        // SDK's own request handler, which converts ANY thrown error (ours or the SDK's own
        // McpError) into a structured `{ content: [...], isError: true }` result — never an
        // uncaught crash. Duplicating that conversion here would just be a second, divergent
        // error-formatting path.
        const result = await logMcpTool(tool.name, args, () => tool.handler(args));
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
