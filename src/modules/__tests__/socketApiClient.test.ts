import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchSocketFindings,
  SocketAuthError,
  type FetchFn,
  type PackageRef,
} from "../socketApiClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures/socket-output");

async function loadFixture(name: string): Promise<string> {
  return readFile(resolve(FIXTURES, name), "utf8");
}

function makeRef(overrides: Partial<PackageRef> = {}): PackageRef {
  return {
    ecosystem: "npm",
    package: "foo",
    version: "1.0.0",
    manifestPath: "/repo/package.json",
    ...overrides,
  };
}

function mockFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>): FetchFn {
  let callIndex = 0;
  return vi.fn(async (_url, _init) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const { status, body = "[]", headers = {} } = resp;
    return new Response(body, { status, headers });
  }) as unknown as FetchFn;
}

const TEST_TOKEN = "test-token-abc123";

describe("fetchSocketFindings", () => {
  beforeEach(() => {
    delete process.env.SOCKET_API_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SOCKET_API_TOKEN;
  });

  it("returns { findings: [], available: true } immediately without calling fetch when packages is empty", async () => {
    const fetch = vi.fn() as unknown as FetchFn;
    const result = await fetchSocketFindings([], { fetch, token: TEST_TOKEN });
    expect(result).toEqual({ findings: [], available: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws SocketAuthError when SOCKET_API_TOKEN is missing and no token option passed", async () => {
    await expect(
      fetchSocketFindings([makeRef()], { fetch: vi.fn() as unknown as FetchFn })
    ).rejects.toThrow(SocketAuthError);
  });

  it("throws SocketAuthError with SOCKET_API_TOKEN message when token missing", async () => {
    await expect(
      fetchSocketFindings([makeRef()], { fetch: vi.fn() as unknown as FetchFn })
    ).rejects.toThrow(/SOCKET_API_TOKEN/);
  });

  it("reads SOCKET_API_TOKEN from process.env when no token option", async () => {
    process.env.SOCKET_API_TOKEN = TEST_TOKEN;
    const body = await loadFixture("no-alerts.json");
    const fetch = mockFetch([{ status: 200, body }]);
    const result = await fetchSocketFindings([makeRef()], { fetch });
    expect(result.available).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("throws SocketAuthError on 401", async () => {
    const fetch = mockFetch([{ status: 401 }]);
    await expect(
      fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN })
    ).rejects.toThrow(SocketAuthError);
  });

  it("throws SocketAuthError on 403", async () => {
    const fetch = mockFetch([{ status: 403 }]);
    await expect(
      fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN })
    ).rejects.toThrow(SocketAuthError);
  });

  it("throws SocketAuthError mentioning the status on 401/403", async () => {
    const fetch = mockFetch([{ status: 401 }]);
    await expect(
      fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN })
    ).rejects.toThrow(/status: 401/);
  });

  it("sends Authorization: Bearer header", async () => {
    const body = await loadFixture("no-alerts.json");
    const mockFn = vi.fn(async () => new Response(body, { status: 200 })) as unknown as FetchFn;
    await fetchSocketFindings([makeRef()], { fetch: mockFn, token: TEST_TOKEN });
    const [, init] = (mockFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("happy path: one batch, one package with one alert → one Finding", async () => {
    const body = await loadFixture("one-alert.json");
    const fetch = mockFetch([{ status: 200, body }]);
    const ref = makeRef({ ecosystem: "npm", package: "foo", version: "1.0.0", manifestPath: "/repo/package.json" });

    const result = await fetchSocketFindings([ref], { fetch, token: TEST_TOKEN });

    expect(result.available).toBe(true);
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0];
    expect(f.source).toBe("socket");
    expect(f.ecosystem).toBe("npm");
    expect(f.package).toBe("foo");
    expect(f.version).toBe("1.0.0");
    expect(f.findingId).toBe("malware");
    expect(f.severity).toBe("CRITICAL");
    expect(f.manifestPath).toBe("/repo/package.json");
  });

  it("happy path: multiple alerts per package → multiple Findings", async () => {
    const body = await loadFixture("multiple-alerts.json");
    const fetch = mockFetch([{ status: 200, body }]);
    const result = await fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN });
    expect(result.available).toBe(true);
    expect(result.findings).toHaveLength(3);
    const ids = result.findings.map((f) => f.findingId);
    expect(ids).toContain("malware");
    expect(ids).toContain("typosquat");
    expect(ids).toContain("install-scripts");
  });

  it("info-severity Socket alerts are filtered out", async () => {
    const body = await loadFixture("info-only.json");
    const fetch = mockFetch([{ status: 200, body }]);
    const result = await fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN });
    expect(result.available).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("no-alerts response yields empty findings with available: true", async () => {
    const body = await loadFixture("no-alerts.json");
    const fetch = mockFetch([{ status: 200, body }]);
    const result = await fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN });
    expect(result).toEqual({ findings: [], available: true });
  });

  describe("severity mapping", () => {
    async function makeAlertBody(severity: string): Promise<string> {
      return JSON.stringify([{ purl: "pkg:npm/foo@1.0.0", alerts: [{ type: "test-alert", severity }] }]);
    }

    it.each([
      ["low", "LOW"],
      ["middle", "MEDIUM"],
      ["high", "HIGH"],
      ["critical", "CRITICAL"],
    ])("maps Socket severity '%s' → internal '%s'", async (socketSev, internalSev) => {
      const body = await makeAlertBody(socketSev);
      const fetch = mockFetch([{ status: 200, body }]);
      const result = await fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN });
      expect(result.findings[0]?.severity).toBe(internalSev);
    });

    it("maps unknown severity string → UNKNOWN", async () => {
      const body = await makeAlertBody("critical+");
      const fetch = mockFetch([{ status: 200, body }]);
      const result = await fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN });
      expect(result.findings[0]?.severity).toBe("UNKNOWN");
    });
  });

  describe("PURL ecosystem mapping", () => {
    it.each([
      ["pypi", "pip", "requests", "2.28.0"],
      ["golang", "gomod", "github.com%2Fuser%2Frepo", "1.0.0"],
      ["cargo", "cargo", "serde", "1.0.0"],
      ["maven", "maven", "com.example%2Flib", "1.0.0"],
      ["gem", "gem", "rails", "7.0.0"],
      ["composer", "composer", "vendor%2Fpackage", "1.0.0"],
    ])(
      "maps purl type '%s' → ecosystem '%s'",
      async (purlType, expectedEcosystem, pkgEncoded, version) => {
        const pkgDecoded = decodeURIComponent(pkgEncoded);
        const body = JSON.stringify([{
          purl: `pkg:${purlType}/${pkgEncoded}@${version}`,
          alerts: [{ type: "malware", severity: "critical", props: { title: "Malware" } }],
        }]);
        const ref: PackageRef = {
          ecosystem: expectedEcosystem as PackageRef["ecosystem"],
          package: pkgDecoded,
          version,
          manifestPath: "/repo/manifest",
        };
        const fetch = mockFetch([{ status: 200, body }]);
        const result = await fetchSocketFindings([ref], { fetch, token: TEST_TOKEN });
        expect(result.findings[0]?.ecosystem).toBe(expectedEcosystem);
      }
    );
  });

  describe("retry behaviour", () => {
    it("retry then success: first attempt 503, second succeeds → one Finding, fetch called twice", async () => {
      const successBody = await loadFixture("one-alert.json");
      const fetch = mockFetch([
        { status: 503 },
        { status: 200, body: successBody },
      ]);
      const result = await fetchSocketFindings([makeRef()], { fetch, token: TEST_TOKEN });
      expect(result.available).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it("retry then success: first attempt 429 with Retry-After, second succeeds", async () => {
      const successBody = await loadFixture("one-alert.json");
      let callCount = 0;
      const mockFn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("", { status: 429, headers: { "Retry-After": "0" } });
        }
        return new Response(successBody, { status: 200 });
      }) as unknown as FetchFn;

      const result = await fetchSocketFindings([makeRef()], {
        fetch: mockFn,
        token: TEST_TOKEN,
        backoffBaseMs: 1,
      });

      expect(result.available).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("permanent failure fail-open: three 503 attempts → returns { findings: [], available: false }", async () => {
      const fetch = mockFetch([
        { status: 503 },
        { status: 503 },
        { status: 503 },
      ]);

      const result = await fetchSocketFindings([makeRef()], {
        fetch,
        token: TEST_TOKEN,
        backoffBaseMs: 1,
      });

      expect(result).toEqual({ findings: [], available: false });
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    });

    it("network-error fail-open: fetch rejects with a TypeError → retries, then returns { findings: [], available: false }", async () => {
      const fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as FetchFn;

      const result = await fetchSocketFindings([makeRef()], {
        fetch,
        token: TEST_TOKEN,
        backoffBaseMs: 1,
      });

      expect(result).toEqual({ findings: [], available: false });
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    });

    it("timeout fail-open: AbortController aborts, retries, ultimately fails open", async () => {
      const fetch = vi.fn(async (_url: unknown, init: { signal?: AbortSignal }) => {
        // Simulate hanging: wait for abort
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
          // Never resolves on its own
        });
      }) as unknown as FetchFn;

      const result = await fetchSocketFindings([makeRef()], {
        fetch,
        token: TEST_TOKEN,
        timeoutMs: 50,
        backoffBaseMs: 1,
      });

      expect(result).toEqual({ findings: [], available: false });
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    });

    it("malformed JSON response → fail-open", async () => {
      const fetch = mockFetch([
        { status: 200, body: "not valid json{{" },
        { status: 200, body: "not valid json{{" },
        { status: 200, body: "not valid json{{" },
      ]);

      const result = await fetchSocketFindings([makeRef()], {
        fetch,
        token: TEST_TOKEN,
        backoffBaseMs: 1,
      });

      expect(result).toEqual({ findings: [], available: false });
    });
  });

  describe("batching", () => {
    it("batches requests at 1000 PURLs per POST (2100 packages → 3 batches)", async () => {
      const packages: PackageRef[] = Array.from({ length: 2100 }, (_, i) => ({
        ecosystem: "npm" as const,
        package: `pkg-${i}`,
        version: "1.0.0",
        manifestPath: "/repo/package.json",
      }));

      // Each batch gets one empty response
      const fetch = mockFetch([
        { status: 200, body: "[]" },
        { status: 200, body: "[]" },
        { status: 200, body: "[]" },
      ]);
      const result = await fetchSocketFindings(packages, { fetch, token: TEST_TOKEN });
      expect(result.available).toBe(true);
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    });

    it("batch failure propagates fail-open for the whole run", async () => {
      const packages: PackageRef[] = Array.from({ length: 2100 }, (_, i) => ({
        ecosystem: "npm" as const,
        package: `pkg-${i}`,
        version: "1.0.0",
        manifestPath: "/repo/package.json",
      }));

      // First batch succeeds, second batch always fails
      let batchCall = 0;
      const fetch = vi.fn(async () => {
        batchCall++;
        if (batchCall === 1) return new Response("[]", { status: 200 });
        return new Response("", { status: 503 });
      }) as unknown as FetchFn;

      const result = await fetchSocketFindings(packages, {
        fetch,
        token: TEST_TOKEN,
        backoffBaseMs: 1,
      });

      expect(result).toEqual({ findings: [], available: false });
    });
  });

  it("attributes findings to the correct manifestPath when a package appears in multiple manifests", async () => {
    const ref1: PackageRef = { ecosystem: "npm", package: "foo", version: "1.0.0", manifestPath: "/repo/package.json" };
    const ref2: PackageRef = { ecosystem: "npm", package: "foo", version: "1.0.0", manifestPath: "/repo/packages/app/package.json" };
    const body = JSON.stringify([{
      purl: "pkg:npm/foo@1.0.0",
      alerts: [{ type: "malware", severity: "critical", props: { title: "Malware" } }],
    }]);
    const fetch = mockFetch([{ status: 200, body }]);
    const result = await fetchSocketFindings([ref1, ref2], { fetch, token: TEST_TOKEN });

    expect(result.findings).toHaveLength(2);
    const paths = result.findings.map((f) => f.manifestPath);
    expect(paths).toContain("/repo/package.json");
    expect(paths).toContain("/repo/packages/app/package.json");
  });

  it("Retry-After header with malformed value falls back to exponential backoff", async () => {
    const successBody = await loadFixture("one-alert.json");
    let callCount = 0;
    const mockFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "not-a-number" } });
      }
      return new Response(successBody, { status: 200 });
    }) as unknown as FetchFn;

    const result = await fetchSocketFindings([makeRef()], {
      fetch: mockFn,
      token: TEST_TOKEN,
      backoffBaseMs: 1,
    });

    expect(result.available).toBe(true);
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});
