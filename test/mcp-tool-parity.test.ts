import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/router.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";

/**
 * Every CLI command mirrored as an MCP tool MUST appear here, and this is the ONLY place a
 * deliberate divergence is allowed — the spirit of `test/cli-grammar-parity.test.ts`'s "no silent
 * drift" contract, applied one surface over. `tn mcp serve` is the sole entry: the MCP server
 * cannot register itself as a tool of itself (there is no service function to call — starting the
 * server IS the operation), so it is CLI-only by construction, not an oversight.
 */
const CLI_ONLY_COMMANDS = new Set(["mcp serve"]);

function commandKey(c: { noun: string; verb: string }): string {
  return `${c.noun} ${c.verb}`;
}

describe("MCP <-> CLI grammar parity", () => {
  it("every registered CLI command has a correspondingly-named MCP tool (noun_verb), except the explicit opt-out list", () => {
    const toolNames = new Set(MCP_TOOLS.map((t) => t.name));
    for (const c of COMMANDS) {
      const key = commandKey(c);
      if (CLI_ONLY_COMMANDS.has(key)) continue;
      const expectedToolName = key.replace(" ", "_");
      expect(toolNames, `no MCP tool named "${expectedToolName}" for CLI command "tn ${key}"`).toContain(
        expectedToolName,
      );
    }
  });

  it("every MCP tool maps back to a registered CLI command with the matching noun_verb name", () => {
    const registeredKeys = new Set(COMMANDS.map(commandKey));
    for (const tool of MCP_TOOLS) {
      expect(
        registeredKeys,
        `MCP tool "${tool.name}" (cliCommand "${tool.cliCommand}") has no matching registered CLI command`,
      ).toContain(tool.cliCommand);
      expect(tool.name, `MCP tool "${tool.name}" does not mirror its own cliCommand's noun_verb spelling`).toBe(
        tool.cliCommand.replace(" ", "_"),
      );
    }
  });

  it("the opt-out list contains only commands that are genuinely CLI-only (never a tool ALSO exists for them)", () => {
    const toolCliCommands = new Set(MCP_TOOLS.map((t) => t.cliCommand));
    for (const key of CLI_ONLY_COMMANDS) {
      expect(toolCliCommands.has(key), `"${key}" is in the opt-out list but also has an MCP tool`).toBe(false);
      expect(COMMANDS.map(commandKey), `"${key}" is in the opt-out list but is not even a registered CLI command`).toContain(key);
    }
  });

  it("MCP_TOOLS carries exactly one entry per name (no accidental duplicate registration)", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
