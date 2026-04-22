import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postSlackNotification, type FetchFn } from "../slackReporter.js";

function mockFetch(response: {
  status?: number;
  statusText?: string;
  ok?: boolean;
}): FetchFn {
  return vi.fn(async () => {
    const status = response.status ?? 200;
    const ok = response.ok ?? (status >= 200 && status < 300);
    return new Response("ok", {
      status,
      statusText: response.statusText ?? "",
    }) as unknown as Response;
  }) as unknown as FetchFn;
}

let savedWebhookUrl: string | undefined;
let savedTimeoutMs: string | undefined;

beforeEach(() => {
  savedWebhookUrl = process.env["SLACK_WEBHOOK_URL"];
  savedTimeoutMs = process.env["SLACK_REQUEST_TIMEOUT_MS"];
  delete process.env["SLACK_WEBHOOK_URL"];
  delete process.env["SLACK_REQUEST_TIMEOUT_MS"];
});

afterEach(() => {
  if (savedWebhookUrl === undefined) delete process.env["SLACK_WEBHOOK_URL"];
  else process.env["SLACK_WEBHOOK_URL"] = savedWebhookUrl;
  if (savedTimeoutMs === undefined) delete process.env["SLACK_REQUEST_TIMEOUT_MS"];
  else process.env["SLACK_REQUEST_TIMEOUT_MS"] = savedTimeoutMs;
});

describe("postSlackNotification", () => {
  it("returns posted:false when SLACK_WEBHOOK_URL is unset; does not call fetch", async () => {
    const fetchFn = mockFetch({ status: 200 });
    const result = await postSlackNotification("hello", { fetch: fetchFn });
    expect(result.posted).toBe(false);
    expect(result.reason).toMatch(/SLACK_WEBHOOK_URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns posted:false when SLACK_WEBHOOK_URL is empty string; does not call fetch", async () => {
    const fetchFn = mockFetch({ status: 200 });
    const result = await postSlackNotification("hello", {
      fetch: fetchFn,
      webhookUrl: "",
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toMatch(/SLACK_WEBHOOK_URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns posted:false when webhookUrl is whitespace-only; does not call fetch", async () => {
    const fetchFn = mockFetch({ status: 200 });
    const result = await postSlackNotification("hello", {
      fetch: fetchFn,
      webhookUrl: "   ",
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toMatch(/SLACK_WEBHOOK_URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns posted:true on 200 and calls fetch exactly once with correct args", async () => {
    const fetchFn = mockFetch({ status: 200 });
    const result = await postSlackNotification("hello", {
      fetch: fetchFn,
      webhookUrl: "http://example.com/webhook",
    });
    expect(result.posted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://example.com/webhook");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe("hello");
  });

  it("returns posted:false on 503 response; does not throw", async () => {
    const fetchFn = mockFetch({ status: 503 });
    const result = await postSlackNotification("hello", {
      fetch: fetchFn,
      webhookUrl: "http://example.com/webhook",
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toMatch(/503/);
  });

  it("returns posted:false on AbortError (timeout); does not throw", async () => {
    const abortingFetch: FetchFn = vi.fn((_url, init) => {
      return new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as FetchFn;
    const result = await postSlackNotification("hello", {
      fetch: abortingFetch,
      webhookUrl: "http://example.com/webhook",
      timeoutMs: 50,
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });

  it("returns posted:false on network TypeError; does not throw", async () => {
    const errorFetch: FetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as FetchFn;
    const result = await postSlackNotification("hello", {
      fetch: errorFetch,
      webhookUrl: "http://example.com/webhook",
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toMatch(/failed/i);
  });

  it("honours options.webhookUrl over process.env.SLACK_WEBHOOK_URL", async () => {
    process.env["SLACK_WEBHOOK_URL"] = "http://env-url.com/webhook";
    const fetchFn = mockFetch({ status: 200 });
    await postSlackNotification("hello", {
      fetch: fetchFn,
      webhookUrl: "http://options-url.com/webhook",
    });
    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://options-url.com/webhook");
  });

  it("uses process.env.SLACK_WEBHOOK_URL when options.webhookUrl is not set", async () => {
    process.env["SLACK_WEBHOOK_URL"] = "http://env-url.com/webhook";
    const fetchFn = mockFetch({ status: 200 });
    await postSlackNotification("hello", { fetch: fetchFn });
    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://env-url.com/webhook");
  });

  it("body sent to fetch is exactly JSON.stringify({ text })", async () => {
    const fetchFn = mockFetch({ status: 200 });
    await postSlackNotification("exact text", {
      fetch: fetchFn,
      webhookUrl: "http://example.com/webhook",
    });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe(JSON.stringify({ text: "exact text" }));
  });

  it("honours options.timeoutMs — triggers abort before default 5000ms", async () => {
    const start = Date.now();
    const abortingFetch: FetchFn = vi.fn((_url, init) => {
      return new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as FetchFn;
    const result = await postSlackNotification("hello", {
      fetch: abortingFetch,
      webhookUrl: "http://example.com/webhook",
      timeoutMs: 80,
    });
    const elapsed = Date.now() - start;
    expect(result.posted).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});
