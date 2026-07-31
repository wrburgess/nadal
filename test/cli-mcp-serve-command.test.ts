import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { createMcpServeRunner, mcpServe } from "../src/cli/commands/mcp-serve.js";

/** A minimal fake `Transport` — just enough surface for `McpServer#connect` to attach its handlers
 * and for the test to drive `onclose`/`onerror` itself, without any real stdin/stdout piping. */
class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  started = false;
  closed = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  async send(): Promise<void> {
    // No messages are sent in these tests.
  }
}

describe("tn mcp serve", () => {
  it("is registered under noun=mcp verb=serve with the GRAMMAR.md-matching summary", () => {
    expect(mcpServe.noun).toBe("mcp");
    expect(mcpServe.verb).toBe("serve");
    expect(mcpServe.summary).toBe("Run the MCP server over stdio, mirroring the CLI grammar as tools");
  });

  it("connects the MCP server to the given transport and resolves 0 once the transport closes", async () => {
    const transport = new FakeTransport();
    const run = createMcpServeRunner(() => transport);

    const resultPromise = run([]);
    // Give `server.connect(transport)` a tick to attach its handlers before closing.
    await Promise.resolve();
    await transport.close();

    await expect(resultPromise).resolves.toBe(0);
    expect(transport.started).toBe(true);
  });

  it("rejects if the transport reports an error", async () => {
    const transport = new FakeTransport();
    const run = createMcpServeRunner(() => transport);

    const resultPromise = run([]);
    await Promise.resolve();
    const boom = new Error("transport boom");
    transport.onerror?.(boom);

    await expect(resultPromise).rejects.toBe(boom);
  });

  it("the default runner (no argument) is wired to the real StdioServerTransport by construction", () => {
    // Not exercised end-to-end here (that would require real stdin/stdout piping) — this pins that
    // `createMcpServeRunner()` with no argument is a valid zero-arg call, i.e. its default parameter
    // is well-formed, which is what makes `mcpServe.run` (defined as `createMcpServeRunner()`) valid.
    expect(() => createMcpServeRunner()).not.toThrow();
  });

  // REGRESSION — caught by actually running a built `tn mcp serve` end to end and piping a finite
  // script into it: the real StdioServerTransport (`@modelcontextprotocol/sdk`) never calls its own
  // `onclose` on stdin EOF, only on an explicit `close()`. Without this fix, that left the runner's
  // Promise unsettled forever on a graceful stdin close, and Node exited with code 13 ("unsettled
  // top-level await") plus a stderr warning instead of a clean 0 exit.
  it("stdin EOF closes the transport and resolves 0 — the real StdioServerTransport does not do this on its own", async () => {
    const transport = new FakeTransport();
    const stdinListeners: Array<() => void> = [];
    const fakeStdin = {
      once: (_event: "end", listener: () => void) => {
        stdinListeners.push(listener);
      },
    };
    const run = createMcpServeRunner(() => transport, fakeStdin);

    const resultPromise = run([]);
    await Promise.resolve();
    expect(transport.closed).toBe(false);

    // Simulate stdin EOF — no real pipe involved, exactly the seam this test exists to isolate.
    for (const listener of stdinListeners) listener();

    await expect(resultPromise).resolves.toBe(0);
    expect(transport.closed).toBe(true);
  });
});
