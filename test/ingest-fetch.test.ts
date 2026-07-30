import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FetchError, fetchPage } from "../src/ingest/fetch.js";

let server: Server | undefined;

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe("fetchPage", () => {
  it("returns body, status, and a fetchedAt timestamp on 200", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>ok</html>");
    });

    const page = await fetchPage(`${base}/team`, { politenessMs: 0 });

    expect(page.body).toBe("<html>ok</html>");
    expect(page.status).toBe(200);
    expect(page.url).toBe(`${base}/team`);
    expect(page.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("sends the shared capture-fixture user-agent header", async () => {
    let seenUserAgent: string | undefined;
    const base = await listen((req, res) => {
      seenUserAgent = req.headers["user-agent"];
      res.writeHead(200);
      res.end("ok");
    });

    await fetchPage(base, { politenessMs: 0 });

    expect(seenUserAgent).toContain("Mozilla/5.0");
    expect(seenUserAgent).toContain("Chrome/131");
  });

  it("throws FetchError with status and url on 404", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });

    await expect(fetchPage(base, { politenessMs: 0 })).rejects.toMatchObject({
      status: 404,
      url: base,
    });
    await expect(fetchPage(base, { politenessMs: 0 })).rejects.toBeInstanceOf(FetchError);
  });

  it("throws FetchError with status and url on 500", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(500);
      res.end("server error");
    });

    await expect(fetchPage(base, { politenessMs: 0 })).rejects.toMatchObject({
      status: 500,
      url: base,
    });
  });

  it("rejects when the server never responds (timeout)", async () => {
    const base = await listen(() => {
      // never respond
    });

    await expect(fetchPage(base, { politenessMs: 0, timeoutMs: 20 })).rejects.toThrow();
  }, 2000);

  it("separates two successive calls by at least the politeness interval, without actually sleeping", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    let now = 1_000_000;
    const clock = { now: () => now };
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    };

    await fetchPage(base, { politenessMs: 1500, clock, sleep });
    await fetchPage(base, { politenessMs: 1500, clock, sleep });

    expect(sleeps).toEqual([1500]);
  });

  it("does not sleep on the first call, or when enough time has already elapsed", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    let now = 2_000_000;
    const clock = { now: () => now };
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    };

    await fetchPage(base, { politenessMs: 1500, clock, sleep });
    now += 5000;
    await fetchPage(base, { politenessMs: 1500, clock, sleep });

    expect(sleeps).toEqual([]);
  });
});

// Codex adversarial review, PR #31 [medium x2]: the politeness pacing and the non-2xx path both had
// failure modes the existing tests structurally could not observe.
describe("fetchPage — concurrency and non-2xx handling", () => {
  it("REGRESSION: concurrent callers are paced, not released together", async () => {
    let virtualNow = 0;
    const clock = { now: () => virtualNow };
    // The property under test is WHEN each request is released, not how long any one caller slept —
    // the fake clock advances as earlier callers wait, so the durations alone are ambiguous.
    const startedAt: number[] = [0];
    const sleep = async (ms: number) => {
      virtualNow += ms;
      startedAt.push(virtualNow);
    };

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>ok</html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/`;

    try {
      await Promise.all([
        fetchPage(url, { clock, sleep, politenessMs: 1500 }),
        fetchPage(url, { clock, sleep, politenessMs: 1500 }),
        fetchPage(url, { clock, sleep, politenessMs: 1500 }),
      ]);

      // Caller 1 goes immediately; 2 and 3 each wait for their OWN reserved slot, 1500ms apart.
      // Before the fix, callers 2 and 3 both observed the same "last call" timestamp — caller 3 saw
      // 1500ms already elapsed and skipped its wait entirely — so the releases were [0, 1500, 1500]
      // and two requests went out together.
      expect(startedAt).toEqual([0, 1500, 3000]);
    } finally {
      server.close();
    }
  });

  it("REGRESSION: a non-2xx whose body never ends still rejects with FetchError, not a timeout", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.write("start of an error body that never completes");
      // deliberately never res.end() — the response body hangs open
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    try {
      await expect(fetchPage(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 })).rejects.toThrow(FetchError);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 10_000);
});
