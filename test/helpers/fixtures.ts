import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceRef } from "../../src/parsers/types.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export type Fixture = { html: string; source: SourceRef };

/**
 * Load a captured page together with the `SourceRef` recorded when it was captured, so no test
 * invents a URL or a fetch date. Both are real values from `tools/capture-fixture.ts` — the URL
 * carries the same synthetic identities as the page it points at (see `test/fixtures/README.md`).
 */
export function loadFixture(name: string): Fixture {
  const path = join(FIXTURE_ROOT, `${name}.html`);
  const provenance = JSON.parse(readFileSync(`${path}.provenance.json`, "utf8")) as {
    sourceUrl: string;
    fetchedAt: string;
  };
  return {
    html: readFileSync(path, "utf8"),
    source: { url: provenance.sourceUrl, fetchedAt: provenance.fetchedAt },
  };
}
