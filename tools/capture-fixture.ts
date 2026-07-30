/**
 * Capture a parser fixture: take a page (fetched live, or read from a local archive of an earlier
 * login-assisted capture), redact it, and write it next to a provenance record.
 *
 * Spec § Ingestion requires every fetch to save its raw page — "the TDD substrate and the re-parse
 * archive". This tool is the substrate half: the fixtures under `test/fixtures/` are what the
 * parsers are tested against, and the provenance record is what makes a stale fixture legible
 * (which URL, which day, what status) instead of a mystery blob.
 *
 * Usage:
 *   tsx tools/capture-fixture.ts --url <url> --map <path> --detectors <set> --out <path>
 *   tsx tools/capture-fixture.ts --file <path> --source-url <url> --map <path> \
 *                                --detectors <set> --out <path>
 *
 * `--map` points at a substitution file OUTSIDE this repository: it pairs real identities with
 * their synthetic stand-ins, so committing it would publish precisely the data redaction removes.
 * Shape: { "substitutions": [ { "from": "...", "to": "..." } ] }
 *
 * `--detectors` defaults to "none" when omitted, and "none" has no committed default vocabulary
 * file — so a capture with no `--detectors` and no explicit `--vocabulary` REFUSES outright rather
 * than running with the allow-list policy silently disabled. Pass `--vocabulary <path>` naming a
 * skeleton vocabulary file to run a "none"-detector capture at all.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redact, type Detector, type Substitution } from "./redact-fixture.js";
import { loadStandIns, loadVocabulary } from "./fixture-policy.js";

/**
 * Per-source structural sweeps. Each pattern captures an identity the site advertises in its own
 * markup, so a name absent from the substitution map is still caught.
 */
const DETECTOR_SETS: Record<string, Detector[]> = {
  // A query-param value here can contain a literal space (`playername=Luke Hamann&year=2026`),
  // so these stop at `&` or a quote — never at whitespace, which would truncate every surname
  // away and let the sweep pass on a first name it could not recognise.
  tennisrecord: [
    { name: "playername", pattern: /playername=([^"&']+)/g },
    { name: "teamname", pattern: /teamname=([^"&']+)/g },
  ],
  // The ID sweeps alone left the page's most exposed field uncovered: with a uaid in the map but
  // the player's NAME omitted, the id was replaced, both sweeps passed, and the real displayed
  // name shipped. A structural sweep has to cover what a human reading the page would recognise,
  // not only what looks like an identifier.
  // (Provenance: Codex adversarial review round 3 on PR #26.)
  usta: [
    { name: "uaid", pattern: /uaid[=:]([0-9]+)/g },
    { name: "tennis-id", pattern: /tennis-id=([A-Z0-9]+)/gi },
    {
      name: "displayed name",
      pattern: /data-element-name="fullName"[\s\S]{0,400}?<h3[^>]*>([^<]+)<\/h3>/g,
    },
    {
      name: "displayed location",
      pattern:
        /data-element-name="nameGenderAddress"[\s\S]{0,400}?<\/span>\s*\|\s*([^<|]+?)\s*<br/g,
    },
  ],
  none: [],
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36";

export type Provenance = {
  sourceUrl: string;
  fetchedAt: string;
  httpStatus: number | null;
  redacted: true;
  bytesBefore: number;
  bytesAfter: number;
  note: string;
};

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function required(argv: string[], name: string): string {
  const value = arg(argv, name);
  if (value === undefined) throw new Error(`missing required flag --${name}`);
  return value;
}

/**
 * Default vocabulary path for a detector set — `tools/fixture-vocabulary/<set>.txt`, resolved
 * relative to this script rather than the caller's cwd. The "none" set (used by generic/ad-hoc
 * captures with no source-specific detectors) has no committed vocabulary file, so it resolves no
 * default here — `main()` then REFUSES the capture unless an explicit `--vocabulary` is given
 * (issue #28 follow-up fix): the allow-list policy is the closed boundary this tool exists to
 * enforce, and it must never be possible to reach a written fixture without it, default
 * invocation included.
 */
function defaultVocabularyPath(detectorSet: string): string | undefined {
  if (detectorSet === "none") return undefined;
  return join(dirname(fileURLToPath(import.meta.url)), "fixture-vocabulary", `${detectorSet}.txt`);
}

/**
 * The committed stand-ins register (`tools/fixture-vocabulary/stand-ins.txt`) — used ONLY to
 * enforce `loadVocabulary()`'s `# reviewed[synthetic]:` claims. Deliberately the committed file,
 * not this run's own out-of-repo `--map` substitutions (`standIns` below): a vocabulary file's
 * "synthetic" claims are a property of the FILE, checked the same way whoever loads it — a live
 * capture here or the CI-facing completeness test with no map in hand at all.
 */
function committedStandInsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fixture-vocabulary", "stand-ins.txt");
}

export async function main(argv: string[]): Promise<void> {
  const out = required(argv, "out");
  const mapPath = required(argv, "map");
  const detectorSet = arg(argv, "detectors") ?? "none";
  const detectors = DETECTOR_SETS[detectorSet];
  if (detectors === undefined) {
    throw new Error(`unknown detector set "${detectorSet}" (have: ${Object.keys(DETECTOR_SETS).join(", ")})`);
  }

  const { substitutions } = JSON.parse(readFileSync(mapPath, "utf8")) as {
    substitutions: Substitution[];
  };

  // The allow-list policy (tools/fixture-policy.ts, issue #28): every capture is checked against a
  // per-source vocabulary of skeletons, in ADDITION to the forbidden-value/detector sweeps below.
  // standIns are the synthetic replacement values from THIS capture's own map — available here
  // because, unlike the CI-facing completeness test, capture-fixture.ts runs with the real
  // out-of-repo map in hand.
  const vocabularyPath = arg(argv, "vocabulary") ?? defaultVocabularyPath(detectorSet);
  if (vocabularyPath === undefined) {
    // No default vocabulary resolved (detector set "none") and no explicit --vocabulary was
    // given — the DEFAULT invocation shape. Refusing here is the whole point of task 9/issue #28:
    // a capture must never proceed without an allow-list. There is deliberately no bypass flag;
    // see this function's caller-facing docs (tools/capture-fixture.ts usage comment /
    // test/fixtures/README.md) for how to pick or create a vocabulary file.
    throw new Error(
      `refusing to capture: detector set "${detectorSet}" has no default vocabulary file, and no ` +
        `--vocabulary was given. A capture must never run without the allow-list policy enforced ` +
        `(tools/fixture-policy.ts) — pass --vocabulary <path> naming the skeleton vocabulary file ` +
        `to check this capture against (see test/fixtures/README.md § Re-capturing), or choose a ` +
        `--detectors set with a committed default (e.g. tennisrecord, usta).`,
    );
  }
  const vocabulary = loadVocabulary(vocabularyPath, loadStandIns(committedStandInsPath()));
  const standIns = substitutions.map((s) => s.to);

  const url = arg(argv, "url");
  const file = arg(argv, "file");
  let raw: string;
  let httpStatus: number | null = null;
  let sourceUrl: string;

  if (url !== undefined) {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    httpStatus = response.status;
    raw = await response.text();
    sourceUrl = url;
    if (!response.ok) throw new Error(`fetch failed: ${response.status} ${url}`);
  } else if (file !== undefined) {
    raw = readFileSync(file, "utf8");
    sourceUrl = required(argv, "source-url");
  } else {
    throw new Error("one of --url or --file is required");
  }

  // redact() is redact-then-verify in one call: no capture path can write a fixture that has not
  // passed the allow-list policy, the forbidden-value sweep, AND the structural detector sweep.
  const redacted = redact(raw, substitutions, { detectors, vocabulary, standIns });

  // The URL is redacted with the same map as the page, and — like the page — VERIFIED before it
  // is written, INCLUDING against the allow-list policy. A TennisRecord URL carries the player's
  // name and a USTA profile URL carries the uaid, so a provenance file is a second publication
  // surface with the same exposure as the fixture; redacting it without asserting the result would
  // leave that surface guarded only by whether the operator happened to list every identity the
  // URL contains. Nothing is written below until BOTH calls have returned successfully.
  const redactedUrl = redact(sourceUrl, substitutions, { detectors, vocabulary, standIns });
  const provenance: Provenance = {
    sourceUrl: redactedUrl,
    fetchedAt: new Date().toISOString(),
    httpStatus,
    redacted: true,
    bytesBefore: raw.length,
    bytesAfter: redacted.length,
    note: "Identities substituted in both the page and this sourceUrl; script/style bodies and base64 payloads stripped. Element tree, classes and attributes are unchanged — see tools/redact-fixture.ts.",
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, redacted);
  writeFileSync(`${out}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`captured ${out} (${raw.length} -> ${redacted.length} bytes)`);
}

// Only auto-run when this file is executed directly (`tsx tools/capture-fixture.ts ...`), not
// when imported as a module — `test/tools-capture-fixture.test.ts` imports `main` to call it
// directly against a temp dir, and an unguarded top-level call would run it with the TEST
// RUNNER's argv the moment the module loads.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
