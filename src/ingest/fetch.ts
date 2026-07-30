/**
 * The live-fetch half of the ingestion seam: every pipeline takes a `PageFetcher` rather than
 * calling `fetch` itself, so production wiring passes `fetchPage` and every test passes a stub
 * that never touches the network (see `test/helpers/stub-fetcher.ts`).
 */
export type FetchedPage = {
  url: string;
  status: number;
  body: string;
  fetchedAt: string;
};

export type PageFetcher = (url: string) => Promise<FetchedPage>;

/** A fetch that completed but with a non-2xx status. Carries what a caller needs to report it. */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

// Same real user-agent constant `tools/capture-fixture.ts` sends — presenting as the same client
// on both the fixture-capture and the production-pull paths.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36";

const DEFAULT_POLITENESS_MS = 1500;
const DEFAULT_TIMEOUT_MS = 20_000;

export type Clock = { now(): number };
export type Sleep = (ms: number) => Promise<void>;

export type FetchPageOptions = {
  /** Minimum interval between two calls sharing the same `clock`. Default 1500ms. */
  politenessMs?: number;
  /** Abort a request that has not completed within this many ms. Default 20000ms. */
  timeoutMs?: number;
  /** Injectable so tests can assert politeness without a real sleep. Defaults to the wall clock. */
  clock?: Clock;
  /** Injectable so tests never actually wait. Defaults to a real `setTimeout`-backed sleep. */
  sleep?: Sleep;
};

const realClock: Clock = { now: () => Date.now() };
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keyed by clock identity (not a single module-level number) so production's single shared
// `realClock` accumulates one running "next permitted call" timestamp across every real call, while
// each test's own injected `clock` object gets its own independent state and tests never interfere
// with each other's politeness bookkeeping.
//
// This stores a RESERVED slot, not a "last call at". A plain read-sleep-write sequence is not
// serialized: `Promise.all([fetchPage(a), fetchPage(b)])` had both callers observe the same
// timestamp, sleep the same duration, and then fire together — defeating the pacing at exactly the
// moment it matters most. (Codex adversarial review, PR #31, rated medium.) Each caller instead
// claims the next slot SYNCHRONOUSLY, before its first await, so claims cannot interleave.
const nextSlotByClock = new WeakMap<Clock, number>();

/**
 * Fetch a page: Node's global `fetch`, the shared capture user-agent, a request timeout, and a
 * politeness delay relative to the last call sharing the same clock. Throws `FetchError` (never
 * resolves) on a non-2xx response, carrying `status` and `url` for the caller to report.
 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const politenessMs = options.politenessMs ?? DEFAULT_POLITENESS_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.clock ?? realClock;
  const sleep = options.sleep ?? realSleep;

  // Claimed synchronously — no `await` between reading and writing the slot, so two concurrent
  // callers cannot both claim the same one.
  const now = clock.now();
  const slot = Math.max(now, nextSlotByClock.get(clock) ?? now);
  nextSlotByClock.set(clock, slot + politenessMs);
  if (slot > now) await sleep(slot - now);

  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Checked BEFORE the body is read. Reading first meant a server that sent 404/500 headers and
  // then streamed an endless body left the caller blocked until the abort timeout, surfacing a
  // timeout error instead of the documented FetchError — and buffering an arbitrarily large error
  // body on the way. (Codex adversarial review, PR #31, rated medium.) The body of a failed
  // response is not something this caller ever uses.
  if (!response.ok) {
    throw new FetchError(`fetch failed with status ${response.status}: ${url}`, response.status, url);
  }

  const body = await response.text();
  const fetchedAt = new Date().toISOString();

  return { url, status: response.status, body, fetchedAt };
}
