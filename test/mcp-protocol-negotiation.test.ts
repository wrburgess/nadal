// What the MCP connection does BEFORE any tool is called (#106) — the decision to stay on
// `@modelcontextprotocol/sdk` v1 / spec revision `2025-11-25` rests on how the SDK's own request
// machinery treats a client from a NEWER revision, and this file is the record of it. Those
// behaviors were read out of `node_modules/@modelcontextprotocol/sdk/dist/esm/` during the
// assessment; a source read is not a measurement, so they are asserted here rather than written
// down in prose that nothing checks. That distinction earned itself twice while this file was
// written: the unknown-tool case came back in a different shape than the source read predicted, and
// the stateless case (no `initialize` at all) contradicted the assessment's one stated exposure.
//
// Sibling of `test/mcp-tools.test.ts`, deliberately not a duplicate: that file connects a real SDK
// `Client` and tests what the TOOLS do. A real `Client` cannot be used here, because it announces
// its OWN `LATEST_PROTOCOL_VERSION` on every `initialize` — which is precisely the value under test.
// So this file drives the client half of the transport pair with hand-written JSON-RPC.
//
// The named trigger this file guards, from the #106 decision: "an MCP client connects to
// `tn mcp serve` and lists ZERO tools." That is the one observation which converts the currency
// question into a bug, and `lists every registered tool` below is its literal negation.

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCError, JSONRPCMessage, JSONRPCResponse } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { useTnDbPath } from "./helpers/tn-db.js";

/** The ceiling of the installed v1 SDK (`LATEST_PROTOCOL_VERSION` in its own `types.js`). */
const SDK_CEILING = "2025-11-25";
/** The revision this issue is about — newer than anything the installed SDK knows. */
const NEW_REVISION = "2026-07-28";
/** A revision the installed SDK DOES support, used to prove the negotiation is real. */
const KNOWN_OLDER_REVISION = "2025-06-18";
/** JSON-RPC's own reserved code for an unimplemented method. */
const METHOD_NOT_FOUND = -32601;

type Reply = JSONRPCResponse | JSONRPCError;

/**
 * A hand-driven JSON-RPC client over the client half of an `InMemoryTransport` pair, with the real
 * `createMcpServer()` on the other half.
 *
 * `onmessage` is assigned BEFORE `start()` on purpose: `InMemoryTransport.send` delivers directly
 * when the far side has an `onmessage` and otherwise QUEUES, draining only in `start()`. A reply
 * that arrived while the handler was unset would then be delivered to nobody, and the awaiting
 * promise would hang until vitest's timeout rather than fail on the assertion — a slow, misleading
 * red. Assigning first removes that window entirely.
 */
async function rawConnection(): Promise<{
  request(method: string, params?: Record<string, unknown>): Promise<Reply>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Reply) => void>();

  clientTransport.onmessage = (message: JSONRPCMessage) => {
    // A server-initiated notification carries no `id` and belongs to nobody here; an `id` we never
    // issued is likewise not ours. Both are dropped rather than mis-resolving someone's request.
    if (!("id" in message)) return;
    const resolve = pending.get(Number(message.id));
    if (!resolve) return;
    pending.delete(Number(message.id));
    resolve(message as Reply);
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  let nextId = 0;
  return {
    async request(method, params = {}) {
      const id = ++nextId;
      // Resolve on EITHER a result or an error reply. Rejecting on the error branch would turn a
      // JSON-RPC error into a thrown value, and the whole point of the `server/discover` case below
      // is that its error is an ordinary, assertable answer.
      const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
      await clientTransport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
      return reply;
    },
    async notify(method, params = {}) {
      await clientTransport.send({ jsonrpc: "2.0", method, params } as JSONRPCMessage);
    },
    close: () => clientTransport.close(),
  };
}

function resultOf(reply: Reply): Record<string, unknown> {
  if ("error" in reply) {
    throw new Error(`expected a result, got JSON-RPC error ${reply.error.code}: ${reply.error.message}`);
  }
  return reply.result as Record<string, unknown>;
}

function errorOf(reply: Reply): { code: number; message: string } {
  if (!("error" in reply)) {
    throw new Error(`expected a JSON-RPC error, got a result: ${JSON.stringify(reply.result)}`);
  }
  return reply.error;
}

function toolNamesIn(reply: Reply): string[] {
  const tools = resultOf(reply).tools as Array<{ name: string }>;
  return tools.map((t) => t.name).sort();
}

describe("MCP protocol negotiation (raw JSON-RPC against the real server)", () => {
  // The negotiation and listing paths never reach a tool handler, so no database should be opened
  // at all. This fixture is a containment measure rather than a setup step: if that ever stops
  // being true, the write lands in a temp directory instead of whatever `TN_DB_PATH` names on the
  // machine running the suite.
  useTnDbPath("mcp-negotiation.db");

  it(`accepts an initialize declaring ${NEW_REVISION} and negotiates down to the SDK's ceiling`, async () => {
    const conn = await rawConnection();

    const result = resultOf(
      await conn.request("initialize", {
        protocolVersion: NEW_REVISION,
        capabilities: {},
        clientInfo: { name: "raw-test-client", version: "0.0.0" },
      }),
    );

    // The load-bearing assertion for #106: a client speaking the new revision is NOT refused. The
    // server answers with a result at a version it can actually speak, which is what leaves the
    // client free to proceed at that version.
    expect(result.protocolVersion).toBe(SDK_CEILING);
    expect(result.serverInfo).toMatchObject({ name: "tn" });

    await conn.close();
  });

  it(`echoes back ${KNOWN_OLDER_REVISION}, so the case above is a real negotiation and not a constant`, async () => {
    const conn = await rawConnection();

    const result = resultOf(
      await conn.request("initialize", {
        protocolVersion: KNOWN_OLDER_REVISION,
        capabilities: {},
        clientInfo: { name: "raw-test-client", version: "0.0.0" },
      }),
    );

    // Without this test the one above passes against a server that ignores the request entirely and
    // always answers with its own ceiling — the exact mutant its single assertion cannot kill. Here
    // the reply can only be this value if the requested version was read.
    expect(result.protocolVersion).toBe(KNOWN_OLDER_REVISION);

    await conn.close();
  });

  it("answers server/discover with a recoverable Method not found and keeps serving the same connection", async () => {
    const conn = await rawConnection();
    await conn.request("initialize", {
      protocolVersion: NEW_REVISION,
      capabilities: {},
      clientInfo: { name: "raw-test-client", version: "0.0.0" },
    });
    await conn.notify("notifications/initialized");

    const error = errorOf(await conn.request("server/discover"));
    expect(error.code).toBe(METHOD_NOT_FOUND);

    // Asserting the error code alone would not distinguish "declined this call" from "the
    // connection is now unusable", and that distinction IS the fallback: a `2026-07-28` client is
    // expected to probe with `server/discover` and, on refusal, carry on over the same connection.
    // If the refusal killed the transport, the fallback the decision relies on would not exist.
    expect(toolNamesIn(await conn.request("tools/list")).length).toBeGreaterThan(0);

    await conn.close();
  });

  it("lists every registered tool — the literal negation of the decision's named trigger", async () => {
    const conn = await rawConnection();
    await conn.request("initialize", {
      protocolVersion: NEW_REVISION,
      capabilities: {},
      clientInfo: { name: "raw-test-client", version: "0.0.0" },
    });
    await conn.notify("notifications/initialized");

    const listed = toolNamesIn(await conn.request("tools/list"));

    // "Zero tools" is the trigger; this is its negation, asserted directly rather than implied.
    expect(listed.length).toBeGreaterThan(0);
    // And every entry of the table is proven to have REGISTERED through the SDK, not merely to
    // exist in the array — a registration that threw for one tool would leave the array intact.
    expect(listed).toEqual(MCP_TOOLS.map((t) => t.name).sort());

    await conn.close();
  });

  it("refuses an unknown tool name without ending the connection", async () => {
    const conn = await rawConnection();
    await conn.request("initialize", {
      protocolVersion: NEW_REVISION,
      capabilities: {},
      clientInfo: { name: "raw-test-client", version: "0.0.0" },
    });
    await conn.notify("notifications/initialized");

    // A `2026-07-28` client may probe for tools this server does not have. That must be an ordinary
    // refusal, not a way to take the server down mid-session at a venue.
    //
    // Note the asymmetry with `server/discover` above, which this test was written expecting NOT to
    // find and which the first run corrected: an unknown METHOD is a JSON-RPC transport-level error
    // (`-32601`), but an unknown TOOL NAME comes back as a successful JSON-RPC *result* carrying
    // `isError: true` — the structured-error contract `src/mcp/server.ts` documents in its own
    // handler comment ("converts ANY thrown error into a structured `{ content, isError: true }`
    // result — never an uncaught crash"). Both are recoverable; they are recoverable at different
    // layers, and a test that conflated them would be asserting a shape the SDK never produces.
    const reply = resultOf(await conn.request("tools/call", { name: "server_discover", arguments: {} }));
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain("server_discover");

    expect(toolNamesIn(await conn.request("tools/list")).length).toBeGreaterThan(0);

    await conn.close();
  });

  it("serves a fully stateless request that never sends initialize at all — the shape a 2026-07-28 client actually uses", async () => {
    const conn = await rawConnection();

    // `2026-07-28`'s second major change REMOVES the `initialize`/`notifications/initialized`
    // handshake: a client on that revision carries its protocol version and identity in `_meta` on
    // every request instead. #106's own write-up called the missing handshake "the only real
    // exposure" — measurement says otherwise, and that is why this case is asserted rather than
    // reasoned about. The v1 server registers no initialization gate on the request path, so a bare
    // `tools/list` from a client that never handshook is answered in full.
    const listed = toolNamesIn(
      await conn.request("tools/list", {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": NEW_REVISION,
          "io.modelcontextprotocol/clientInfo": { name: "stateless-test-client", version: "0.0.0" },
        },
      }),
    );

    expect(listed).toEqual(MCP_TOOLS.map((t) => t.name).sort());

    await conn.close();
  });

  it("survives a missing and a malformed protocolVersion — the boundary values of the one field this decision turns on", async () => {
    const conn = await rawConnection();

    // Missing: the field is required by the SDK's own initialize schema, so this is a validation
    // refusal rather than a downgrade. Asserted so that the difference between the two is on the
    // record, not inferred.
    const missing = await conn.request("initialize", {
      capabilities: {},
      clientInfo: { name: "raw-test-client", version: "0.0.0" },
    });
    expect("error" in missing).toBe(true);

    // Malformed-but-well-typed: an empty string satisfies the schema and is simply not a supported
    // version, so it takes the same downgrade path as a future revision. This is what makes the
    // downgrade a property of "unrecognized", not of "2026-07-28" specifically.
    const empty = resultOf(
      await conn.request("initialize", {
        protocolVersion: "",
        capabilities: {},
        clientInfo: { name: "raw-test-client", version: "0.0.0" },
      }),
    );
    expect(empty.protocolVersion).toBe(SDK_CEILING);

    await conn.close();
  });
});
