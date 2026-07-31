import type { FetchedPage, PageFetcher } from "../../src/ingest/fetch.js";

export type StubFixture = { body: string; status?: number };

export type StubFetcher = PageFetcher & { calls: string[] };

/**
 * A `PageFetcher` that never touches the network: fixtures are registered by exact URL, and every
 * call is recorded on `.calls` so cascade behavior (e.g. "one fetch per roster profile, exactly
 * once each") can be asserted on the call log rather than inferred from row counts.
 */
export function createStubFetcher(fixtures: Record<string, StubFixture>): StubFetcher {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<FetchedPage> => {
    calls.push(url);
    const fixture = fixtures[url];
    if (fixture === undefined) {
      throw new Error(`stub fetcher: no fixture registered for url "${url}"`);
    }
    return {
      url,
      status: fixture.status ?? 200,
      body: fixture.body,
      fetchedAt: new Date().toISOString(),
    };
  };
  return Object.assign(fetcher, { calls });
}
