/**
 * The fixture allow-list policy — the inversion of `tools/redact-fixture.ts`'s blacklist.
 *
 * `redact-fixture.ts` substitutes every identity someone remembered to list, then sweeps the
 * result for the identity CLASSES it knows how to recognise (a structural detector per source, a
 * five-class never-publish sweep). Both are still a blacklist: content nobody thought to name
 * ships by default. An independent reviewer ruled that unacceptable for a public repository (PR
 * #26, round 12).
 *
 * This module runs AFTER substitution, over the already-redacted output, and inverts the
 * boundary: every content ATOM — a normalised text-node run, a comment body, or a non-structural
 * attribute value — must reduce to an empty SKELETON or one already committed to a per-source
 * VOCABULARY file. Anything else REFUSES the capture outright; nothing is written.
 *
 * The reduction ladder, in order:
 *
 *  1. An attribute whose NAME is numeric, geometric, or enumerated by the HTML/SVG spec (d,
 *     viewBox, width, height, colspan, role, type, …) is admitted without its value ever being
 *     inspected — `extractAtoms` never creates an atom for one. A free-form, author-chosen
 *     attribute (class, id, style, aria-*, data-v-*, …) is NOT exempt — its value is atomised like
 *     any other content, since it is exactly the kind of human-authored string this policy exists
 *     to check (issue #28 finding 2).
 *  2. The atom is normalised through `normalizeForComparison` in `tools/redact-fixture.ts` — the
 *     SAME pipeline the existing survivor sweeps use, so this is not a second, subtly different
 *     normaliser (see that module's docstring on why that would be a bypass).
 *  3. Every synthetic stand-in is elided, anchored at WORD BOUNDARIES, so a stand-in "Lee" does
 *     not blank the middle of a real "Leeson".
 *  4. Every structural run (integers, decimals, US dates, set scores including match-tiebreak
 *     notation, hex colours, SVG path data) is elided.
 *  5. What remains has its punctuation and whitespace collapsed to produce the SKELETON.
 *  6. An empty skeleton is admitted — the atom was purely synthetic and/or structural.
 *  7. A skeleton already present in the vocabulary is admitted.
 *  8. Otherwise the atom REFUSES the capture, reporting every unclassified atom (not only the
 *     first) with its skeleton, node kind and locating DOM path.
 *
 * KNOWN LIMITATION — bare digit runs of ANY length are admitted structurally (step 4's trailing
 * `\b\d+\b` pattern), with no length cap: `computeSkeleton("8165551234", [])` and
 * `computeSkeleton("99999", [])` both reduce to the empty string, same as a two-digit set score.
 * This is deliberate, not an oversight — TennisRecord match ids and SVG path coordinates are
 * legitimate long numeric runs that a real capture must be able to admit, and refusing every long
 * digit run would break real fixtures rather than protect anyone. The practical consequence: this
 * allow-list policy does NOT constrain numeric identifiers (phone numbers, USTA uaids, ITF
 * tennis-ids, match ids) at all — a page could carry an unlisted phone number or id and this
 * module alone would admit it. Those classes are covered by OTHER layers, not this one:
 * `tools/redact-fixture.ts`'s `assertNoUnlistedPii` independently forbids phone numbers (and
 * email addresses, mailto/tel links, street addresses), and the source-specific structural
 * detector sweeps (`DETECTOR_SETS` in `tools/capture-fixture.ts`, e.g. `uaid`, `tennis-id`) cover
 * USTA/ITF identifiers. Do not read "the allow-list policy passed" as "no numeric identifier is
 * present" — read it as "no NON-numeric unclassified content is present"; the numeric-identifier
 * guarantee, such as it is, comes from those other two layers.
 */

import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
// Deliberately circular with tools/redact-fixture.ts: `redact()` there calls `assertAllowListed`
// here (task 9), and this module reuses that module's normalisation helpers rather than
// re-deriving them (see this module's docstring). Both edges are FUNCTION references used only
// inside function bodies — never at module-top-level evaluation — which is what makes the cycle
// safe under Node's ESM loader. `PolicyError` deliberately does NOT extend `RedactionError`: a
// `class X extends Y` reference is evaluated immediately at module load, and doing that across
// this cycle throws "Class extends value undefined" depending on which side of the cycle loads
// first.
import { assertNoUnlistedPii, escapeRegExp, nfc, normalizeForComparison } from "./redact-fixture.js";

export type AtomKind =
  | "text"
  | "attribute"
  | "comment"
  | "element-name"
  | "attribute-name"
  | "directive";

/**
 * One content atom: a normalised text-node run, a comment body, an attribute value, an element
 * NAME, an attribute NAME, or a directive's data (doctype).
 */
export type Atom = {
  kind: AtomKind;
  value: string;
  path: string;
  attrName?: string;
};

/**
 * WHOLE-DOCUMENT ACCOUNTING (issue #28, round-2 adversarial review).
 *
 * Eight structural escapes were found against this control across two rounds, and every single
 * one was the same SHAPE of bug: a category of document content `extractAtoms` never looked at —
 * an element name, an attribute name, a name-only-exempted attribute VALUE with no closed
 * grammar, or a lowercase/non-ASCII identity that `isNameShaped` (now `requiresReview`) waved
 * through. Never a rule that judged an atom wrongly; always an input class the walk never
 * produced an atom for at all. A
 * hand-enumerated set of "the content classes I checked" is a blacklist wearing an allow-list's
 * clothes — the exact complaint that opened issue #28 in the first place.
 *
 * So the walk below is inverted to be POSITIVE rather than enumerative: every node kind
 * cheerio/domhandler can produce for an HTML document — tag (including the `script`/`style`
 * element TYPES, which domhandler tags distinctly from generic `tag` nodes), text, comment, and
 * directive (doctype) — is walked, and EVERY element name and EVERY attribute name is atomised
 * unless it is in a closed, spec-derived allow-list built explicitly in this module (never derived
 * from what the fixtures happen to contain — that would just be a longer blacklist). Content this
 * module does not recognise refuses by construction; it does not need a future reviewer to notice
 * a ninth escape and go name it.
 *
 * (CDATA sections and non-doctype processing instructions are not walked as separate node kinds
 * because cheerio's default, non-XML parse mode never produces them: htmlparser2's HTML tokenizer
 * treats `<![CDATA[...]]>` and `<?...?>` as bogus comments per the HTML5 spec, so their content
 * already reaches this walk through the `comment` branch — confirmed empirically, not assumed, so
 * this is not itself a ninth blind spot.)
 */

/**
 * Attribute NAMES the parser reads purely structurally — their VALUE is never inspected, whatever
 * it is. Principled, not convenient: numeric, geometric, or enumerated-by-spec values only, never
 * a free-form author-chosen string.
 */
const NAME_ONLY_STRUCTURAL_ATTR_NAMES = new Set([
  "d",
  "viewbox",
  "points",
  "transform",
  "width",
  "height",
  "colspan",
  "rowspan",
  "preserveaspectratio",
  "focusable",
  "type",
  "role",
]);

/**
 * A CSS Color Module Level 4 named colour — a genuinely closed enumeration, used to decide
 * whether a `fill`/`stroke` value is exempt (see `CLOSED_VALUE_GRAMMARS` below).
 */
const CSS_NAMED_COLOURS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
  "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
  "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream",
  "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred",
  "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple",
  "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
  "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen",
]);

const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `fill`/`stroke`: a hex colour, a CSS Level 4 named colour, or one of the SVG paint keywords. */
function isClosedPaintValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    v === "none" ||
    v === "currentcolor" ||
    v === "transparent" ||
    v === "context-fill" ||
    v === "context-stroke" ||
    HEX_COLOUR.test(v) ||
    CSS_NAMED_COLOURS.has(v)
  );
}

/**
 * The handful of standard XML/SVG namespace URIs a document can legitimately declare. `xlink` is
 * in this same grammar because htmlparser2's HTML tokenizer (cheerio's default parser, confirmed
 * empirically) does not understand the `xmlns:xlink` PREFIX — it reports the attribute NAME as
 * bare `xlink`, discarding the `xmlns:` half, so the standard `xmlns:xlink="…"` declaration every
 * captured SVG icon carries reaches this walk as an attribute literally named `xlink`. Refusing to
 * recognise that would not protect anyone; the value is still drawn from the same closed URI set.
 */
const STANDARD_NAMESPACE_URIS = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2001/xmlschema-instance",
  "http://www.w3.org/xml/1998/namespace",
]);

function isClosedNamespaceValue(value: string): boolean {
  return STANDARD_NAMESPACE_URIS.has(value.trim().toLowerCase());
}

/**
 * Attribute names whose VALUE is exempt only when it matches a genuinely closed grammar —
 * `xmlns`/`xlink` (round-2 finding R2-1: these used to be name-only exempt, so
 * `xmlns="https://example.test/Patrick-Turner"` created no atom at all) and `fill`/`stroke` (a
 * `url(...)` paint reference must still be atomised).
 */
const CLOSED_VALUE_GRAMMARS: Record<string, (value: string) => boolean> = {
  xmlns: isClosedNamespaceValue,
  xlink: isClosedNamespaceValue,
  fill: isClosedPaintValue,
  stroke: isClosedPaintValue,
};

/** Is this attribute's VALUE exempt from atomisation, given its (lowercased) name? */
function isExemptAttributeValue(lowerName: string, value: string): boolean {
  if (NAME_ONLY_STRUCTURAL_ATTR_NAMES.has(lowerName)) return true;
  const grammar = CLOSED_VALUE_GRAMMARS[lowerName];
  return grammar !== undefined && grammar(value);
}

/**
 * Standard HTML5 (living standard, including legacy/deprecated-but-conforming) and SVG element
 * names, lowercased. Built explicitly from the specs — NOT derived from what the committed
 * fixtures happen to contain, which would just be a longer blacklist (round-2 finding R2-2).
 */
const STANDARD_ELEMENT_NAMES = new Set([
  // HTML
  "a", "abbr", "acronym", "address", "applet", "area", "article", "aside", "audio", "b", "base",
  "basefont", "bdi", "bdo", "big", "blockquote", "body", "br", "button", "canvas", "caption",
  "center", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn",
  "dialog", "dir", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "font",
  "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
  "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label", "legend", "li",
  "link", "main", "map", "mark", "marquee", "menu", "meta", "meter", "nav", "noframes",
  "noscript", "object", "ol", "optgroup", "option", "output", "p", "param", "picture", "pre",
  "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select",
  "slot", "small", "source", "span", "strike", "strong", "style", "sub", "summary", "sup",
  "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr",
  "track", "tt", "u", "ul", "var", "video", "wbr",
  // SVG
  "svg", "animate", "animatemotion", "animatetransform", "circle", "clippath", "defs", "desc",
  "ellipse", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite",
  "feconvolvematrix", "fediffuselighting", "fedisplacementmap", "fedistantlight", "fedropshadow",
  "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "feimage", "femerge",
  "femergenode", "femorphology", "feoffset", "fepointlight", "fespecularlighting", "fespotlight",
  "fetile", "feturbulence", "filter", "foreignobject", "g", "hatch", "hatchpath", "image", "line",
  "lineargradient", "marker", "mask", "metadata", "mpath", "path", "pattern", "polygon",
  "polyline", "radialgradient", "rect", "set", "stop", "switch", "symbol", "text", "textpath",
  "tspan", "use", "view",
]);

function isStandardElementName(name: string): boolean {
  return STANDARD_ELEMENT_NAMES.has(name.toLowerCase());
}

/**
 * Standard global, event-handler, form/media/table, and ARIA HTML attribute names, plus SVG
 * presentation/geometry/animation attribute names — lowercased, spec-derived (not
 * fixture-derived, same reasoning as `STANDARD_ELEMENT_NAMES`).
 *
 * `aria-*` is enumerated explicitly rather than treated as a prefix class: unlike `data-*`, the
 * WAI-ARIA spec defines a CLOSED list of `aria-*` states/properties — `aria-patrick-turner` is not
 * a valid ARIA attribute, so it must not be waved through the way `data-*` is.
 */
const STANDARD_ATTRIBUTE_NAMES = new Set([
  // Global
  "accesskey", "autocapitalize", "autofocus", "class", "contenteditable", "dir", "draggable",
  "enterkeyhint", "hidden", "id", "inert", "inputmode", "is", "itemid", "itemprop", "itemref",
  "itemscope", "itemtype", "lang", "nonce", "part", "popover", "slot", "spellcheck", "style",
  "tabindex", "title", "translate", "role", "xmlns",
  // Event handlers
  "onabort", "onafterprint", "onauxclick", "onbeforeprint", "onbeforeunload", "onblur",
  "oncancel", "oncanplay", "oncanplaythrough", "onchange", "onclick", "onclose",
  "oncontextmenu", "oncopy", "oncuechange", "oncut", "ondblclick", "ondrag", "ondragend",
  "ondragenter", "ondragleave", "ondragover", "ondragstart", "ondrop", "ondurationchange",
  "onemptied", "onended", "onerror", "onfocus", "onformdata", "onhashchange", "oninput",
  "oninvalid", "onkeydown", "onkeypress", "onkeyup", "onload", "onloadeddata",
  "onloadedmetadata", "onloadstart", "onmessage", "onmousedown", "onmouseenter",
  "onmouseleave", "onmousemove", "onmouseout", "onmouseover", "onmouseup", "onoffline",
  "ononline", "onpagehide", "onpageshow", "onpaste", "onpause", "onplay", "onplaying",
  "onpopstate", "onprogress", "onratechange", "onreset", "onresize", "onscroll",
  "onsecuritypolicyviolation", "onseeked", "onseeking", "onselect", "onslotchange",
  "onstalled", "onstorage", "onsubmit", "onsuspend", "ontimeupdate", "ontoggle",
  "onunhandledrejection", "onunload", "onvolumechange", "onwaiting", "onwheel",
  // Element-specific
  "accept", "accept-charset", "action", "allow", "allowfullscreen", "alt", "as", "async",
  "autoplay", "capture", "cellpadding", "cellspacing", "charset", "checked", "cite", "cols",
  "content", "controls", "coords", "crossorigin", "data", "datetime", "decoding", "default",
  "defer", "disabled", "download", "enctype", "for", "form", "formaction", "formenctype",
  "formmethod", "formnovalidate", "formtarget", "headers", "height", "high", "href",
  "hreflang", "http-equiv", "integrity", "ismap", "kind", "label", "list", "loading", "loop",
  "low", "manifest", "max", "maxlength", "media", "method", "min", "minlength", "multiple",
  "muted", "name", "nomodule", "novalidate", "open", "optimum", "pattern", "ping",
  "placeholder", "playsinline", "poster", "preload", "readonly", "referrerpolicy", "rel",
  "required", "reversed", "rows", "rowspan", "sandbox", "scope", "selected", "shape", "size",
  "sizes", "span", "src", "srcdoc", "srclang", "srcset", "start", "step", "target", "usemap",
  "value", "width", "wrap", "colspan", "version",
  // ARIA (closed enumeration, not a prefix class)
  "aria-activedescendant", "aria-atomic", "aria-autocomplete", "aria-braillelabel",
  "aria-brailleroledescription", "aria-busy", "aria-checked", "aria-colcount",
  "aria-colindex", "aria-colindextext", "aria-colspan", "aria-controls", "aria-current",
  "aria-describedby", "aria-description", "aria-details", "aria-disabled",
  "aria-dropeffect", "aria-errormessage", "aria-expanded", "aria-flowto", "aria-grabbed",
  "aria-haspopup", "aria-hidden", "aria-invalid", "aria-keyshortcuts", "aria-label",
  "aria-labelledby", "aria-level", "aria-live", "aria-modal", "aria-multiline",
  "aria-multiselectable", "aria-orientation", "aria-owns", "aria-placeholder",
  "aria-posinset", "aria-pressed", "aria-readonly", "aria-relevant", "aria-required",
  "aria-roledescription", "aria-rowcount", "aria-rowindex", "aria-rowindextext",
  "aria-rowspan", "aria-selected", "aria-setsize", "aria-sort", "aria-valuemax",
  "aria-valuemin", "aria-valuenow", "aria-valuetext",
  // SVG presentation/geometry/animation (beyond the name-only-structural set above)
  "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "fx", "fy", "fr", "dx", "dy",
  "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity",
  "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform",
  "spreadmethod", "patternunits", "patterncontentunits", "patterntransform", "clip-path",
  "clip-rule", "marker-start", "marker-mid", "marker-end", "text-anchor", "font-family",
  "font-size", "font-weight", "letter-spacing", "dominant-baseline", "alignment-baseline",
  "baseline-shift", "pointer-events", "shape-rendering", "vector-effect", "paint-order",
  "in", "in2", "result", "mode", "operator", "values", "edgemode", "stddeviation",
  "diffuseconstant", "specularconstant", "specularexponent", "surfacescale",
  "kernelmatrix", "kernelunitlength", "targetx", "targety", "radius", "xchannelselector",
  "ychannelselector", "scale", "azimuth", "elevation", "limitingconeangle", "pointsatx",
  "pointsaty", "pointsatz", "refx", "refy", "markerwidth", "markerheight", "markerunits",
  "orient", "overflow", "systemlanguage", "requiredextensions", "requiredfeatures",
  "externalresourcesrequired", "attributename", "attributetype", "begin", "dur", "end",
  "restart", "repeatcount", "repeatdur", "calcmode", "keytimes", "keysplines", "keypoints",
  "rotate", "additive", "accumulate", "by", "to", "d", "viewbox", "points", "transform",
  "preserveaspectratio", "focusable", "type",
]);

/**
 * Standard XML-namespace-prefixed attributes htmlparser2's HTML tokenizer (cheerio's default
 * parser) reports with the prefix stripped — confirmed empirically: `xmlns:xlink="…"` arrives as
 * a bare `xlink` attribute, and `xml:space="preserve"` arrives as a bare `space` attribute.
 */
const PARSER_MANGLED_NAMESPACE_ATTR_NAMES = new Set(["xlink", "space"]);

function isStandardAttributeName(name: string): boolean {
  const lower = name.toLowerCase();
  if (STANDARD_ATTRIBUTE_NAMES.has(lower)) return true;
  if (PARSER_MANGLED_NAMESPACE_ATTR_NAMES.has(lower)) return true;
  return false;
}

/**
 * The `data-*` PREFIX is a genuinely open-ended HTML mechanism (custom data attributes) — admit
 * the prefix itself, but return the REMAINDER for atomisation so an identity in it (
 * `data-patrick-turner`) is still caught (round-2 finding R2-2). Returns `null` when `name` is not
 * `data-`-prefixed.
 */
function dataAttrRemainder(name: string): string | null {
  const lower = name.toLowerCase();
  if (!lower.startsWith("data-")) return null;
  const remainder = name.slice(5);
  return remainder === "" ? name : remainder;
}

/** A standard `<!DOCTYPE html>` (any casing), the only directive exempt from atomisation. */
const STANDARD_DOCTYPE = /^!doctype\s+html\s*$/i;

/**
 * Walk EVERY node kind — text, comment, directive (doctype), and tag (including the `script`/
 * `style` element TYPES, which domhandler tags distinctly from generic `tag` nodes) — carrying a
 * locating DOM path for each atom. See the "WHOLE-DOCUMENT ACCOUNTING" note above for why this is
 * a positive walk of every node kind rather than an enumerated list of the ones some past review
 * happened to name.
 */
export function extractAtoms(html: string): Atom[] {
  const $ = cheerio.load(html);
  const atoms: Atom[] = [];

  const walk = (node: AnyNode, path: string): void => {
    if (node.type === "comment") {
      atoms.push({ kind: "comment", value: node.data, path: `${path}>#comment` });
      return;
    }
    if (node.type === "text") {
      if (node.data !== "") atoms.push({ kind: "text", value: node.data, path });
      return;
    }
    if (node.type === "directive") {
      if (!STANDARD_DOCTYPE.test(node.data.trim())) {
        atoms.push({ kind: "directive", value: node.data, path: `${path}>#directive` });
      }
      return;
    }
    // domhandler types a <script>/<style> ELEMENT's `node.type` as "script"/"style", never "tag" —
    // an earlier `if (node.type === "tag") { if (node.tagName === "script" ...) return; }` guard
    // here could never fire, so those elements fell through to the generic children-walk below,
    // which never inspected their ATTRIBUTES at all — a publication surface with no atom and
    // therefore no allow-list check (issue #28 finding 2).
    //
    // A LATER fix (issue #28 finding 1) also made this walk descend into script/style CHILDREN
    // instead of skipping them. The earlier reasoning — "redaction already strips this, so
    // atomising it here would only flood the vocabulary for no privacy gain" — was wrong: it
    // assumed the body reaching this policy had necessarily survived `redactHtml`'s
    // SCRIPT_OR_STYLE regex, which only matches PAIRED `<script>...</script>`/`<style>...</style>`
    // tags. A truncated or malformed capture like `<script>Patrick Turner` (no closing tag) never
    // matches that regex, so its body survives redaction untouched — and the old skip then threw
    // that survivor away unread, producing NO atom and no allow-list check at all. Atomising the
    // text body instead costs nothing for well-formed input: a paired, already-stripped
    // `<script></script>` has no children left to atomise, so the "no flood" property holds
    // exactly when the premise (stripping happened) is actually true, rather than being assumed.
    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const tagPath = `${path}>${node.tagName}`;
      // ELEMENT NAME (round-2 finding R2-2): a tag whose name is not in the closed, spec-derived
      // allow-list is itself an atom — `<patrick-turner>` produced no atom of any kind before this
      // fix, so an identity spelled as a custom element name shipped with an empty vocabulary.
      if (!isStandardElementName(node.tagName)) {
        atoms.push({ kind: "element-name", value: node.tagName, path: tagPath });
      }
      for (const [attrName, attrValue] of Object.entries(node.attribs)) {
        const lowerName = attrName.toLowerCase();
        // ATTRIBUTE NAME (round-2 finding R2-2): `data-*` is a genuinely open-ended HTML
        // mechanism, so only the REMAINDER after the prefix is atomised (`data-patrick-turner` ->
        // `patrick-turner`) — the prefix itself is not a zero-atom escape hatch. Every other
        // non-standard attribute name is atomised whole; `<patrick-turner>` as an attribute name
        // produced no atom at all before this fix, same bug as the element-name case.
        const dataRemainder = dataAttrRemainder(attrName);
        if (dataRemainder !== null) {
          atoms.push({
            kind: "attribute-name",
            value: dataRemainder,
            path: tagPath,
            attrName,
          });
        } else if (!isStandardAttributeName(attrName)) {
          atoms.push({ kind: "attribute-name", value: attrName, path: tagPath, attrName });
        }
        // ATTRIBUTE VALUE, as before, except `xmlns`/`xlink`/`fill`/`stroke` are now exempt only
        // when their value matches a closed grammar rather than by name alone (round-2 finding
        // R2-1: `xmlns="https://example.test/…"` and `fill="url(https://example.test/…)"` used to
        // create no atom at all).
        if (!isExemptAttributeValue(lowerName, attrValue)) {
          atoms.push({ kind: "attribute", value: attrValue, path: tagPath, attrName });
        }
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children) walk(child as AnyNode, tagPath);
      }
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child as AnyNode, path);
    }
  };

  for (const node of $.root().toArray()) walk(node as AnyNode, "");

  return atoms;
}

/**
 * Structural value grammars, elided in order. Decimals/dates/scores/hex-colours run BEFORE the
 * bare integer pattern, so (say) a date's year is not partially consumed by the integer pattern
 * first, which would leave the rest of the date unrecognisable.
 */
const STRUCTURAL_PATTERNS: RegExp[] = [
  // US date: 1/15/2026, 01-15-26.
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  // ISO-shaped date: 2026-01-15.
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // Decimal (a rating like 4.02, or a coordinate).
  /\b\d+\.\d+\b/g,
  // Set score, optionally followed by a (match-)tiebreak: "6-4", "7-6(7)", "6-2 (10-8)".
  /\d{1,2}-\d{1,2}(?:\s?\(\d{1,2}(?:-\d{1,2})?\))?/g,
  // Hex colour.
  /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g,
  // SVG path data: a command letter followed by its numeric argument list.
  /[MmLlHhVvCcSsQqTtAaZz](?:\s*-?\d+(?:\.\d+)?[,\s]*)+/g,
  // Bare integer, last so the classes above get first crack at their digits.
  /\b\d+\b/g,
];

function elideStructuralRuns(value: string): string {
  let out = value;
  for (const pattern of STRUCTURAL_PATTERNS) {
    out = out.replace(pattern, " ");
  }
  return out;
}

/**
 * Elide every stand-in, anchored at word boundaries so a stand-in "Lee" cannot blank the middle
 * of a real "Leeson" and leave "son" behind. Longest-first so a stand-in that is a prefix of a
 * longer one ("Dana" vs "Dana Sample") does not carve up the longer phrase first.
 */
function elideStandIns(value: string, standIns: string[]): string {
  const sorted = [...standIns].filter((s) => s !== "").sort((a, b) => b.length - a.length);
  let out = value;
  for (const standIn of sorted) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(standIn)}\\b`, "gi"), " ");
  }
  return out;
}

/**
 * Strip whatever punctuation remains and collapse whitespace — the SKELETON.
 *
 * Letters are matched with `\p{L}` rather than `\w`, since JS's `\w` is ASCII-only even under the
 * `u` flag: an unqualified `\w` would strip an accented letter as if it were punctuation, silently
 * corrupting the skeleton of any non-ASCII name into something a vocabulary entry could never
 * match.
 */
function toSkeleton(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reduce one atom's raw value to its skeleton, per the ladder in the module docstring. */
export function computeSkeleton(value: string, standIns: string[]): string {
  const normalized = normalizeForComparison(value);
  const withoutStandIns = elideStandIns(normalized, standIns);
  const withoutStructural = elideStructuralRuns(withoutStandIns);
  return toSkeleton(withoutStructural);
}

export type PolicyViolation = {
  skeleton: string;
  kind: AtomKind;
  path: string;
  attrName?: string;
};

/**
 * Thrown when one or more atoms in a capture are neither synthetic, structural, nor already
 * vocabulary-listed — the "not safe to publish" signal for this policy, parallel to
 * `RedactionError` in `tools/redact-fixture.ts` but deliberately its own class rather than a
 * subclass: a `class X extends Y` reference is evaluated at module load, and this module is
 * circularly imported with `redact-fixture.ts` (see the import comment above), so extending
 * across that cycle is unsafe regardless of which side happens to load first.
 */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly violations: PolicyViolation[],
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Fail the capture unless every content atom reduces to an empty skeleton or one already in the
 * vocabulary. `standIns` are the synthetic replacement values from the substitution map (task 9's
 * caller) or from the committed `tools/fixture-vocabulary/stand-ins.txt` (a CI-facing caller that
 * has no access to the out-of-repo map — see the module README / deviation D1).
 */
export function assertAllowListed(
  html: string,
  options: { standIns: string[]; vocabulary: Set<string> },
): void {
  const atoms = extractAtoms(html);
  const violations: PolicyViolation[] = [];
  // `computeSkeleton` always emits NFC (via `normalizeForComparison`); a vocabulary entry
  // authored/committed in NFD must match all the same — normalise the lookup set once rather
  // than requiring every caller to have NFC-normalised the file first.
  const vocabulary = new Set([...options.vocabulary].map((entry) => nfc(entry)));

  for (const atom of atoms) {
    const skeleton = computeSkeleton(atom.value, options.standIns);
    if (skeleton === "") continue;
    if (vocabulary.has(skeleton)) continue;
    violations.push({ skeleton, kind: atom.kind, path: atom.path, attrName: atom.attrName });
  }

  if (violations.length > 0) {
    throw new PolicyError(
      `${violations.length} unclassified atom(s) — not synthetic, not structural, and not in ` +
        `the vocabulary:\n${violations
          .map(
            (v) =>
              `  [${v.kind}${v.attrName !== undefined ? `@${v.attrName}` : ""}] ${v.path}: "${v.skeleton}"`,
          )
          .join("\n")}`,
      violations,
    );
  }
}

/**
 * Two or more consecutive alphabetic tokens — the shape a real personal name (or any other
 * multi-word identity) takes. Exported so `tools/bootstrap-vocabulary.ts` applies the SAME test
 * when deciding which skeletons it may auto-write versus which it must leave for a human to
 * disposition by hand.
 *
 * Renamed from `isNameShaped` and rebuilt on Unicode `\p{L}`/`\p{M}` letter/mark classes rather
 * than ASCII `[A-Z]` (round-2 finding R2-3): capitalisation is not a safety boundary. The old,
 * ASCII-capitalised-only regex let `patrick turner` (lowercase — common in slugs and lower-cased
 * page text) and any non-ASCII name (`josé garcía`) load from a vocabulary file with NO preceding
 * `# reviewed:` justification and let `bootstrapVocabulary` auto-write it — defeating the human-
 * review boundary the whole allow-list design rests on. This test does not claim a match IS a
 * personal name; it claims a match COULD be one, which is why it is worded and named as a review
 * TRIGGER ("requires review") rather than a classification.
 */
export function requiresReview(value: string): boolean {
  return /\p{L}[\p{L}\p{M}'-]*(?:\s+\p{L}[\p{L}\p{M}'-]*)+/u.test(value);
}

/**
 * Load a per-source vocabulary file: one skeleton per line, `#` comments ignored, blank lines
 * reset any pending justification. An entry for which `requiresReview` returns true (two or more
 * consecutive alphabetic tokens, ANY case or script — see that function's docstring for why
 * capitalisation was dropped as the trigger) must be immediately preceded by a justification line,
 * or the file fails to load outright; a plain comment or blank line between the justification and
 * the entry breaks the immediacy on purpose, so one justification cannot be stretched to cover a
 * second entry a human never actually read.
 *
 * Two justification forms exist, and they make different STRENGTHS of claim:
 *
 *  - `# reviewed[synthetic]: <reason>` asserts the entry is an invented stand-in value — a claim
 *    this loader can and does verify, by reusing `computeSkeleton` (the SAME reduction the
 *    allow-list check itself runs, not a second, subtly different one): the entry passes iff
 *    `computeSkeleton(entry, standIns) === ""`, i.e. eliding full stand-in PHRASES at word
 *    boundaries (and structural runs) leaves nothing behind. This is deliberately narrower than
 *    "this string looks synthetic" — a human guessing at syntheticity is exactly the failure this
 *    marker exists to make impossible (issue #28 follow-up: an unenforced "already-redacted
 *    synthetic" claim covered 14 entries that were not backed by any stand-in, several of them
 *    real Kansas City-area place names).
 *
 *    An earlier version of this check verified each CAPITALISED TOKEN in the entry independently
 *    against tokens drawn from `standIns`, rather than requiring the whole entry to be accounted
 *    for by full stand-in phrases. Since the committed register contains both "Avery Ashby" and
 *    "Arden Ashcroft" as separate stand-ins, that independent-token check let a spliced entry
 *    "Avery Ashcroft" — a full name in NEITHER stand-in — pass as "synthetic", because "Avery" and
 *    "Ashcroft" each matched a token from a DIFFERENT stand-in (issue #28 finding 3). Requiring the
 *    full-phrase skeleton to reduce to empty closes that: "Avery Ashcroft" cannot be elided by
 *    either "Avery Ashby" or "Arden Ashcroft" at a word boundary, so it fails to load.
 *  - `# reviewed: <reason>` is the general free-text form for every other honest classification
 *    (a real public place/club/league/section/tournament name, static UI chrome, boilerplate, …).
 *    It is not machine-checked beyond the PII sweep below, the same as before this fix — there is
 *    no automatable test for "is this a real place name", so the loader does not pretend to run
 *    one; a human's read-and-approve judgment is the whole control, same as it always was.
 *
 * Every entry additionally runs through `assertNoUnlistedPii`, so the vocabulary itself cannot
 * become the hole this policy exists to close.
 */
export function loadVocabulary(path: string, standIns: string[] = []): Set<string> {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const vocabulary = new Set<string>();
  let pendingReviewed: { kind: "synthetic" | "plain"; reason: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const syntheticMatch = /^#\s*reviewed\[synthetic\]:\s*(.+)$/i.exec(line);
    if (syntheticMatch) {
      pendingReviewed = { kind: "synthetic", reason: syntheticMatch[1] ?? "" };
      continue;
    }
    const reviewedMatch = /^#\s*reviewed:\s*(.+)$/i.exec(line);
    if (reviewedMatch) {
      pendingReviewed = { kind: "plain", reason: reviewedMatch[1] ?? "" };
      continue;
    }
    if (line === "" || line.startsWith("#")) {
      pendingReviewed = null;
      continue;
    }

    if (vocabulary.has(line)) {
      throw new Error(`duplicate vocabulary entry "${line}" in ${path}`);
    }
    if (requiresReview(line) && pendingReviewed === null) {
      throw new Error(
        `vocabulary entry "${line}" in ${path} requires review (a multi-token alphabetic ` +
          `skeleton) and must be immediately preceded by a "# reviewed: <reason>" or ` +
          `"# reviewed[synthetic]: <reason>" line`,
      );
    }
    if (pendingReviewed?.kind === "synthetic") {
      // The SAME reduction the allow-list check itself runs (`computeSkeleton`), not a second,
      // independent-token check — that independent-token form let a spliced entry like "Avery
      // Ashcroft" pass by matching "Avery" against ONE stand-in and "Ashcroft" against a
      // DIFFERENT one, with no stand-in ever backing the full phrase (issue #28 finding 3).
      // Requiring the whole entry to reduce to an empty skeleton after eliding full stand-in
      // phrases at word boundaries closes that: a real identity with mere token overlap survives.
      const remainder = computeSkeleton(line, standIns);
      if (remainder !== "") {
        throw new Error(
          `synthetic-classed vocabulary entry "${line}" in ${path} is not fully accounted for ` +
            `by stand-ins.txt — content not present in stand-ins: "${remainder}" remains after ` +
            `eliding full stand-in phrases at word boundaries — reclassify with a plain ` +
            `"# reviewed: <reason>" line (e.g. real-public) if it is a real public name, or add ` +
            `the missing stand-in phrase(s) to stand-ins.txt if it is genuinely synthetic; do ` +
            `not weaken this check`,
        );
      }
    }
    assertNoUnlistedPii(line);

    vocabulary.add(line);
    pendingReviewed = null;
  }

  return vocabulary;
}

/**
 * Load the committed synthetic stand-in list (`tools/fixture-vocabulary/stand-ins.txt`): one
 * stand-in value per line, `#` comments ignored. These are invented names/locations/ids by
 * construction — the name-shape review gate above does NOT apply, since every line here is
 * name-shaped by definition and already known-synthetic (see deviation D1 in the PR that added
 * this file).
 */
export function loadStandIns(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}
