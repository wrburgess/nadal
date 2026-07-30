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
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactHtml, assertRedacted, type Detector, type Substitution } from "./redact-fixture.js";

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
  usta: [
    { name: "uaid", pattern: /uaid[=:]([0-9]+)/g },
    { name: "tennis-id", pattern: /tennis-id=([A-Z0-9]+)/gi },
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

async function main(argv: string[]): Promise<void> {
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

  const redacted = redactHtml(raw, substitutions);
  assertRedacted(redacted, {
    forbidden: substitutions.map((s) => s.from),
    detectors,
    allowed: substitutions.map((s) => s.to),
  });

  // The URL is redacted with the same map as the page. A TennisRecord URL carries the player's
  // name and a USTA profile URL carries the uaid, so recording it verbatim would re-publish
  // through the provenance file exactly what the page redaction removed — and it keeps the
  // recorded URL consistent with the identities inside the fixture, which is what the parsers
  // read it back as.
  const provenance: Provenance = {
    sourceUrl: redactHtml(sourceUrl, substitutions),
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

await main(process.argv.slice(2));
