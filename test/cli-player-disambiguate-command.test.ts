// Issue #94. `tn player distinct` / `tn player alias` end-to-end through `dispatch`, plus the loop
// that is the point of the whole issue: a pull refuses an ambiguity, a human rules on it, the SAME
// pull goes through. Asserted with the real pipeline rather than by inspecting rows — "a row exists"
// and "the pull that was blocked now completes" are different claims, and only the second one is
// what the issue asked for.

import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/router.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { backfillNameKeys } from "../src/db/name-key.js";
import { playerAliases, players } from "../src/db/schema.js";
import * as fetchModule from "../src/ingest/fetch.js";
import { resolvePlayer } from "../src/ingest/identity.js";
import { loadFixture } from "./helpers/fixtures.js";
import { useTnDbPath } from "./helpers/tn-db.js";
import { useTnRawPath } from "./helpers/tn-raw.js";

const matchHistory = loadFixture("tennisrecord/match-history");

/** Seeds one player through the ladder itself, then closes the connection — the CLI opens its own. */
function seed(names: string[]): void {
  runMigrations();
  const { db, sqlite } = openDb();
  for (const name of names) resolvePlayer(db, { name });
  sqlite.close();
}

function seedDirect(names: string[]): void {
  runMigrations();
  const { db, sqlite } = openDb();
  for (const name of names) db.insert(players).values({ canonicalName: name }).run();
  backfillNameKeys(db);
  sqlite.close();
}

function readPlayers(): string[] {
  const { db, sqlite } = openDb();
  const rows = db.select().from(players).all().map((p) => p.canonicalName);
  sqlite.close();
  return rows;
}

describe("tn player distinct (end-to-end via dispatch)", () => {
  useTnDbPath("cmd.db");
  useTnRawPath();

  it("creates the player and names who it is now distinct from, exit 0", async () => {
    seed(["Mason Davis"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Karson Davis"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'player distinct status=ok player="Karson Davis" created="true" distinctFrom="Mason Davis"',
    );
    vi.restoreAllMocks();
  });

  it("a repeat is a no-op that still exits 0, with created=false telling them apart", async () => {
    seed(["Mason Davis"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await dispatch(["player", "distinct", "Karson Davis"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["player", "distinct", "Karson Davis"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('player distinct status=ok player="Karson Davis" created="false"');
    expect(readPlayers().filter((n) => n === "Karson Davis")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("refuses a name that is near nothing, exit 1, and writes no row", async () => {
    seed(["Mason Davis"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Wilhelmina Fotheringay"]);

    expect(code).toBe(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("is not ambiguous");
    expect(readPlayers()).toEqual(["Mason Davis"]);
    vi.restoreAllMocks();
  });

  it("refuses when the name is already on two rows, naming both, exit 1", async () => {
    seedDirect(["Karson Davis", "karson davis"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Karson Davis"]);

    expect(code).toBe(1);
    const printed = String(errSpy.mock.calls[0]?.[0]);
    expect(printed).toContain("already on file more than once");
    expect(printed).toContain("merging");
    expect(readPlayers()).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("refuses a missing target, exit 1", async () => {
    seed([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('player distinct status=error message="missing target"');
    vi.restoreAllMocks();
  });

  // #142, at the CLI surface. The pair form's whole reason to exist is an empty database — both
  // sides of the ambiguity rolled back with the pull that reported them.
  it("settles an ambiguity with neither side on file, naming the counterpart, exit 0", async () => {
    seed([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Maria Negron", "Marie Negron"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'player distinct status=ok player="Maria Negron" created="true" ' +
        'distinctFrom="Marie Negron" alsoCreated="Marie Negron"',
    );
    expect(readPlayers().sort()).toEqual(["Maria Negron", "Marie Negron"]);
    vi.restoreAllMocks();
  });

  // `alsoCreated=` appears only when a second person was minted, so its ABSENCE on the single-name
  // form is part of the contract — a caller reading it as "a second row was written" must not be
  // able to see it on a run that wrote one row.
  it("omits alsoCreated on the single-name form", async () => {
    seed(["Mason Davis"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await dispatch(["player", "distinct", "Karson Davis"]);

    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain("alsoCreated");
    vi.restoreAllMocks();
  });

  it("refuses a counterpart that is not near the target, exit 1, writing nothing", async () => {
    seed([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Maria Negron", "Wilhelmina Fotheringay"]);

    expect(code).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("further apart than the fuzzy radius");
    expect(readPlayers()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("refuses two spellings of one name, exit 1, writing nothing", async () => {
    seed([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Maria Negron", "maria negron"]);

    expect(code).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("the same name to the identity ladder");
    expect(readPlayers()).toEqual([]);
    vi.restoreAllMocks();
  });

  // The refusal an operator meeting #142 actually hits is `not-ambiguous` on the SINGLE-name form.
  // If that message does not name the way out, the fix is unreachable from where the problem is
  // met — which is how #142 cost a registered player's whole season in the first place.
  it("points a not-ambiguous refusal at the pair form", async () => {
    seed([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatch(["player", "distinct", "Maria Negron"]);

    const printed = String(errSpy.mock.calls[0]?.[0]);
    expect(printed).toContain("rolled back with that pull");
    expect(printed).toContain('tn player distinct \\"Maria Negron\\" \\"<the name it was near>\\"');
    vi.restoreAllMocks();
  });

  // The ambiguous side can be the COUNTERPART, and a message that always named the target would
  // send the operator after a row that is fine.
  it("names the COUNTERPART when it is the side already on two rows", async () => {
    seedDirect(["Marie Negron", "marie negron"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Maria Negron", "Marie Negron"]);

    expect(code).toBe(1);
    const printed = String(errSpy.mock.calls[0]?.[0]);
    expect(printed).toContain('\\"Marie Negron\\" is already on file more than once');
    expect(printed).not.toContain('\\"Maria Negron\\" is already on file');
    expect(readPlayers().sort()).toEqual(["Marie Negron", "marie negron"]);
    vi.restoreAllMocks();
  });

  it("refuses an unrecognized flag rather than ignoring it", async () => {
    seed(["Mason Davis"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Karson Davis", "--bogus"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized flag --bogus"));
    vi.restoreAllMocks();
  });

  it("--json emits the same facts as a parseable object", async () => {
    seed(["Mason Davis"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "distinct", "Karson Davis", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      status: "ok",
      player: "Karson Davis",
      created: "true",
      distinctFrom: "Mason Davis",
    });
    vi.restoreAllMocks();
  });
});

describe("tn player alias (end-to-end via dispatch)", () => {
  useTnDbPath("cmd.db");
  useTnRawPath();

  it("records the second spelling against the known player, exit 0", async () => {
    seed(["Robert Smith"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "alias", "Robert Smith", "Bob Smith"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'player alias status=ok player="Robert Smith" alias="Bob Smith" recorded="true"',
    );
    vi.restoreAllMocks();
  });

  it("a repeat is a no-op that still exits 0, with recorded=false", async () => {
    seed(["Robert Smith"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await dispatch(["player", "alias", "Robert Smith", "Bob Smith"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await dispatch(["player", "alias", "Robert Smith", "Bob Smith"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'player alias status=ok player="Robert Smith" alias="Bob Smith" recorded="false"',
    );
    vi.restoreAllMocks();
  });

  it("refuses an alias another player already answers to, naming that player, exit 1", async () => {
    seed(["Robert Smith", "Bob Smith"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "alias", "Robert Smith", "Bob Smith"]);

    expect(code).toBe(1);
    const printed = String(errSpy.mock.calls[0]?.[0]);
    expect(printed).toContain("already belongs to Bob Smith");
    expect(printed).toContain("permanently");
    vi.restoreAllMocks();
  });

  it("refuses an unknown known-target, exit 1, creating nothing", async () => {
    seed([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "alias", "Nobody On File", "Bob Smith"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('player alias status=error message="unknown target \\"Nobody On File\\""');
    expect(readPlayers()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("refuses an ambiguous known-target with the same three facts every other refusal reports", async () => {
    seedDirect(["Nova Norbury", "Nova Norbary"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "alias", "Nova Norbiry", "Nova N"]);

    expect(code).toBe(1);
    const printed = String(errSpy.mock.calls[0]?.[0]);
    expect(printed).toContain('ambiguous identity \\"Nova Norbiry\\" (player name target) — near:');
    vi.restoreAllMocks();
  });

  it("refuses a missing second name rather than recording something ambiguous, exit 1", async () => {
    seed(["Robert Smith"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await dispatch(["player", "alias", "Robert Smith"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      'player alias status=error message="usage: tn player alias <known> <other>"',
    );
    vi.restoreAllMocks();
  });

  // `--` is the end-of-flags delimiter (#17 PR A), and a real TennisRecord name could begin with a
  // hyphen. Asserted here for the same reason `player note` asserts it: this is the only way such a
  // name can be supplied at all.
  it("records a second spelling that begins with -- when it follows the delimiter", async () => {
    seed(["Robert Smith"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await dispatch(["player", "alias", "Robert Smith", "--", "--Bob Smith"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'player alias status=ok player="Robert Smith" alias="--Bob Smith" recorded="true"',
    );
    vi.restoreAllMocks();
  });
});

// The loop the whole issue exists to close, run end to end. This is the only test here that proves
// the two commands are worth having: everything above asserts they write what they say they write,
// and this asserts that what they write is what unblocks the pull.
describe("the refuse -> rule -> retry loop (#94)", () => {
  useTnDbPath("cmd.db");
  useTnRawPath();

  function stubFetch(): void {
    vi.spyOn(fetchModule, "fetchPage").mockImplementation(async (url: string) => ({
      url,
      status: 200,
      body: matchHistory.html,
      fetchedAt: new Date().toISOString(),
    }));
  }

  it("distinct: a pull refused on a partner's name completes after the ruling", async () => {
    // "Nova Norbary" one edit from the fixture's "Nova Norbury" partner — the live shape of this
    // was `Karson Davis` (incoming) against an on-file `Mason Davis`.
    seed(["Nova Norbary"]);
    stubFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // 1. Refused, naming the incoming name — not the profiled player, who resolves fine.
    expect(await dispatch(["player", "pull", matchHistory.source.url])).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('ambiguous identity \\"Nova Norbury\\" (match partner)');

    // 2. The human rules: different people.
    expect(await dispatch(["player", "distinct", "Nova Norbury"])).toBe(0);

    // 3. The SAME pull now completes.
    logSpy.mockClear();
    expect(await dispatch(["player", "pull", matchHistory.source.url])).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0])).toMatch(/^player pull status=ok player=".+" matches=14/);

    // Both names are on file as separate people, which is what the ruling asserted.
    const names = readPlayers();
    expect(names).toContain("Nova Norbury");
    expect(names).toContain("Nova Norbary");
    vi.restoreAllMocks();
  });

  it("alias: the same refusal, ruled the other way, resolves to the EXISTING player with no new row", async () => {
    seed(["Nova Norbary"]);
    stubFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await dispatch(["player", "pull", matchHistory.source.url])).toBe(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('ambiguous identity \\"Nova Norbury\\" (match partner)');

    // The human rules: same person, two spellings.
    expect(await dispatch(["player", "alias", "Nova Norbary", "Nova Norbury"])).toBe(0);

    expect(await dispatch(["player", "pull", matchHistory.source.url])).toBe(0);

    // No second row for the partner — the whole difference between this ruling and the other one.
    expect(readPlayers().filter((n) => n === "Nova Norbury")).toHaveLength(0);
    const { db, sqlite } = openDb();
    const aliasRows = db.select().from(playerAliases).all().filter((a) => a.alias === "Nova Norbury");
    sqlite.close();
    expect(aliasRows).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
