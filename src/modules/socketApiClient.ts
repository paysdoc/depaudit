import type { Ecosystem, Finding, Severity } from "../types/finding.js";

export type FetchFn = typeof globalThis.fetch;

export interface PackageRef {
  ecosystem: Ecosystem;
  package: string;
  version: string;
  manifestPath: string;
}

export interface SocketApiResult {
  findings: Finding[];
  available: boolean;
}

export interface SocketApiOptions {
  fetch?: FetchFn;
  token?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  backoffBaseMs?: number;
}

export class SocketAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketAuthError";
  }
}

// ─── Internal constants ───────────────────────────────────────────────────────

const RETRY_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
// Allow override via env var for testing (keeps BDD scenarios fast)
const PER_REQUEST_TIMEOUT_MS = parseInt(process.env.SOCKET_REQUEST_TIMEOUT_MS ?? "", 10) || 30_000;
const BATCH_SIZE = 1000;

const ECOSYSTEM_TO_PURL_TYPE: Record<Ecosystem, string> = {
  npm: "npm",
  pip: "pypi",
  gomod: "golang",
  cargo: "cargo",
  maven: "maven",
  gem: "gem",
  composer: "composer",
};

const PURL_TYPE_TO_ECOSYSTEM: Record<string, Ecosystem> = {
  npm: "npm",
  pypi: "pip",
  golang: "gomod",
  cargo: "cargo",
  maven: "maven",
  gem: "gem",
  composer: "composer",
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function toPurl(ref: PackageRef): string {
  return `pkg:${ECOSYSTEM_TO_PURL_TYPE[ref.ecosystem]}/${encodeURIComponent(ref.package)}@${encodeURIComponent(ref.version)}`;
}

function parsePurl(purl: string): { ecosystem: Ecosystem; package: string; version: string } | null {
  // pkg:<type>/<name>@<version>
  const match = purl.match(/^pkg:([^/]+)\/(.+)@(.+)$/);
  if (!match) return null;
  const [, type, name, version] = match;
  const ecosystem = PURL_TYPE_TO_ECOSYSTEM[type];
  if (!ecosystem) return null;
  return {
    ecosystem,
    package: decodeURIComponent(name),
    version: decodeURIComponent(version),
  };
}

function mapSocketSeverity(level: string): Severity {
  switch (level.toLowerCase()) {
    case "low": return "LOW";
    case "middle":
    case "medium": return "MEDIUM";
    case "high": return "HIGH";
    case "critical": return "CRITICAL";
    default: return "UNKNOWN";
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchSocketFindings(
  packages: PackageRef[],
  options: SocketApiOptions = {}
): Promise<SocketApiResult> {
  const token = options.token ?? process.env.SOCKET_API_TOKEN;
  if (!token) {
    throw new SocketAuthError("SOCKET_API_TOKEN not set — cannot call Socket API");
  }

  const baseUrl = options.baseUrl ?? process.env.SOCKET_API_BASE_URL ?? "https://api.socket.dev";
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PER_REQUEST_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;

  if (packages.length === 0) {
    return { findings: [], available: true };
  }

  const batches = chunk(packages, BATCH_SIZE);
  const allFindings: Finding[] = [];

  for (const batch of batches) {
    // Map purl → PackageRef[] so we can fan-out findings to each manifestPath
    const purlToRefs = new Map<string, PackageRef[]>();
    for (const ref of batch) {
      const purl = toPurl(ref);
      const existing = purlToRefs.get(purl) ?? [];
      existing.push(ref);
      purlToRefs.set(purl, existing);
    }
    const purls = [...purlToRefs.keys()];

    let batchResult: Finding[] | null = null;

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      // Compose signals: our timeout + any caller-provided signal
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchFn(`${baseUrl}/v0/purl?alerts=true`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ components: purls.map((purl) => ({ purl })) }),
          signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
          throw new SocketAuthError(`Socket API rejected credentials (status: ${response.status})`);
        }

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get("Retry-After") ?? "", 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : backoffBaseMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        if (response.status >= 500) {
          const delay = backoffBaseMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        if (response.status === 404) {
          // Permanent non-auth failure — fail open
          return { findings: [], available: false };
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          // Malformed JSON — treat as transient
          const delay = backoffBaseMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        // Parse successful response
        batchResult = buildFindings(body, purlToRefs);
        break;

      } catch (err: unknown) {
        if (err instanceof SocketAuthError) throw err;
        // Network error, AbortError (timeout), TypeError — transient
        if (attempt < RETRY_ATTEMPTS - 1) {
          const delay = backoffBaseMs * Math.pow(2, attempt);
          await sleep(delay);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (batchResult === null) {
      // All retries exhausted for this batch — fail open for whole run
      return { findings: [], available: false };
    }

    allFindings.push(...batchResult);
  }

  return { findings: allFindings, available: true };
}

function buildFindings(body: unknown, purlToRefs: Map<string, PackageRef[]>): Finding[] {
  const findings: Finding[] = [];

  if (!Array.isArray(body)) return findings;

  for (const component of body) {
    if (!component || typeof component !== "object") continue;
    const { purl, alerts } = component as { purl?: string; alerts?: unknown[] };
    if (!purl || !Array.isArray(alerts)) continue;

    // Normalise the purl from the response — strip query params Socket might add
    const cleanPurl = purl.split("?")[0];

    // Find matching refs by purl or by reconstructing from parsed purl
    const refs = purlToRefs.get(cleanPurl) ?? [];

    // If no direct match, try to find refs by parsing the returned purl
    const parsed = parsePurl(cleanPurl);
    if (refs.length === 0 && parsed) {
      for (const [refPurl, refList] of purlToRefs) {
        const refParsed = parsePurl(refPurl);
        if (
          refParsed &&
          refParsed.ecosystem === parsed.ecosystem &&
          refParsed.package === parsed.package &&
          refParsed.version === parsed.version
        ) {
          refs.push(...refList);
        }
      }
    }

    for (const alert of alerts) {
      if (!alert || typeof alert !== "object") continue;
      const { type, severity, props } = alert as {
        type?: string;
        severity?: string;
        props?: { title?: string };
      };
      if (!type || !severity) continue;
      if (severity.toLowerCase() === "info") continue;

      const mappedSeverity = mapSocketSeverity(severity);

      if (refs.length === 0 && parsed) {
        // Emit one finding without a specific manifestPath if no refs matched
        findings.push({
          source: "socket",
          ecosystem: parsed.ecosystem,
          package: parsed.package,
          version: parsed.version,
          findingId: type,
          severity: mappedSeverity,
          summary: props?.title ?? type,
          manifestPath: "",
        });
      } else {
        for (const ref of refs) {
          findings.push({
            source: "socket",
            ecosystem: ref.ecosystem,
            package: ref.package,
            version: ref.version,
            findingId: type,
            severity: mappedSeverity,
            summary: props?.title ?? type,
            manifestPath: ref.manifestPath,
          });
        }
      }
    }
  }

  return findings;
}
