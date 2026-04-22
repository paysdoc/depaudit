export type FetchFn = typeof globalThis.fetch;

export interface SlackReporterOptions {
  fetch?: FetchFn;
  webhookUrl?: string;
  timeoutMs?: number;
}

export interface SlackPostResult {
  posted: boolean;
  reason?: string;
}

// Honour SLACK_REQUEST_TIMEOUT_MS for BDD timeout scenarios (keeps tests fast).
const DEFAULT_TIMEOUT_MS =
  parseInt(process.env["SLACK_REQUEST_TIMEOUT_MS"] ?? "", 10) || 5000;

function isUsableWebhookUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.trim().length > 0;
}

export async function postSlackNotification(
  text: string,
  options: SlackReporterOptions = {}
): Promise<SlackPostResult> {
  const url = options.webhookUrl ?? process.env["SLACK_WEBHOOK_URL"];
  if (!isUsableWebhookUrl(url)) {
    return { posted: false, reason: "no SLACK_WEBHOOK_URL configured" };
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { posted: false, reason: `webhook returned ${response.status}` };
    }
    return { posted: true };
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e.name === "AbortError") {
      return { posted: false, reason: `webhook request timed out after ${timeoutMs}ms` };
    }
    return { posted: false, reason: `webhook request failed: ${e.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
