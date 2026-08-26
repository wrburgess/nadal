import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOK = join(REPO_ROOT, "docs", "index.html");
const SCOUTING = join(REPO_ROOT, "docs", "scouting");

/**
 * Issue #206. The book is a single hand-edited 800 KB HTML file with no build step,
 * and a prose cut left ONE orphaned `</div>` behind — the opening `<div class="readbox">`
 * went with the block, its closing tag did not.
 *
 * WHY THAT IS WORTH A TEST rather than a careful eye. Nothing errored. The page opened,
 * scrolled and read correctly in a browser, because HTML parsers recover from a stray
 * end tag silently. What it broke was the PRINT: the stray tag closed `.book` early, so
 * `#directory` was no longer where the layout expected it and its `break-before:page`
 * stopped firing. The Directory table printed jammed under the tail of the self-scout,
 * on the page a captain reads at the venue. It survived a full run of the quality gate,
 * a headless print, a page-by-page page-number re-measure and a pushed commit — the
 * measurement even reported a plausible page count (44, one short) rather than failing.
 *
 * WHAT THIS ASSERTS is tag-count balance in the body, nothing more. It cannot see a tag
 * closed in the wrong ORDER, and it is deliberately a count rather than a parse: adding
 * an HTML parser to check one hand-authored file is more machinery than the failure
 * justifies, and a count is what the failure actually was.
 *
 * WHEN THE BOOK IS RETIRED after the tournament, delete this file with it. Like the
 * lineup guard beside it, it fails loudly rather than skipping if its subject is gone.
 */

/** Counts of `<tag` opens and `</tag>` closes, over the body only. */
export function tagBalance(html: string, tag: string): { open: number; close: number } {
  const at = html.indexOf("<body>");
  if (at === -1) throw new Error("no <body> — this is not the document it claims to be");
  const body = html.slice(at);
  return {
    open: (body.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length,
    close: (body.match(new RegExp(`</${tag}>`, "g")) ?? []).length,
  };
}

function pages(): { name: string; html: string }[] {
  const out = [{ name: "docs/index.html", html: readFileSync(BOOK, "utf8") }];
  for (const f of readdirSync(SCOUTING).sort()) {
    if (f.endsWith(".html")) {
      out.push({ name: `docs/scouting/${f}`, html: readFileSync(join(SCOUTING, f), "utf8") });
    }
  }
  return out;
}

describe("every hand-edited page in the game plan closes the tags it opens", () => {
  it("finds all six pages — a suite that reads nothing must not read as balance", () => {
    const found = pages();
    expect(found.map((p) => p.name)).toContain("docs/index.html");
    // Four opponent reports plus the folder's own landing page.
    expect(found.filter((p) => p.name.startsWith("docs/scouting/"))).toHaveLength(5);
    for (const p of found) expect(p.html.length, `${p.name} is empty`).toBeGreaterThan(1000);
  });

  it("div and section open/close counts match on every page", () => {
    const off: string[] = [];
    for (const { name, html } of pages()) {
      for (const tag of ["div", "section"]) {
        const { open, close } = tagBalance(html, tag);
        if (open !== close) {
          off.push(`${name}: ${open} <${tag}> against ${close} </${tag}> (${close - open > 0 ? "+" : ""}${close - open})`);
        }
      }
    }
    expect(
      off,
      `Unbalanced tags. A stray end tag does not error in a browser — it closes an ancestor ` +
        `early and the damage shows up in PRINT, where a section stops starting its own page. ` +
        `See issue #206.\n` + off.join("\n"),
    ).toEqual([]);
  });

  it("catches an orphaned end tag — the guard can fail, on the real defect's shape", () => {
    const html = readFileSync(BOOK, "utf8");
    const broken = html.replace("</table></div>\n\n  <div class=\"sub\">Our Tendencies", "</table></div>\n  </div>\n\n  <div class=\"sub\">Our Tendencies");
    expect(broken, "the seeded defect changed nothing — this probe is measuring itself").not.toEqual(html);
    const { open, close } = tagBalance(broken, "div");
    expect(close - open).toBe(1);
  });

  it("every section in the book carries the class its print break depends on", () => {
    // `section.page{break-before:page}` is what makes each section start a printed page,
    // and the page-number measurement in issue #190 assumes it. A section that lost the
    // class would silently share a page and shift every number after it.
    const html = readFileSync(BOOK, "utf8");
    const sections = [...html.matchAll(/<section\s+([^>]*)>/g)].map((m) => m[1]!);
    expect(sections.length).toBeGreaterThan(20);
    const unclassed = sections.filter((a) => !/class="(page|cover)"/.test(a));
    expect(unclassed, `sections without class="page" or class="cover": ${unclassed}`).toEqual([]);
  });
});
