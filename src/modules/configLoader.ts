import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse } from "smol-toml";
import { parseDocument, LineCounter, YAMLParseError } from "yaml";
import type { OsvScannerConfig, IgnoredVuln } from "../types/osvScannerConfig.js";
import { ConfigParseError } from "../types/osvScannerConfig.js";
import type { DepauditConfig, CommonAndFineEntry, SupplyChainAccept } from "../types/depauditConfig.js";
import { DEFAULT_DEPAUDIT_CONFIG } from "../types/depauditConfig.js";

export { ConfigParseError } from "../types/osvScannerConfig.js";

function findSourceLines(raw: string): number[] {
  const lines: number[] = [];
  const rawLines = raw.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim() === "[[IgnoredVulns]]") {
      lines.push(i + 1);
    }
  }
  return lines;
}

export async function loadOsvScannerConfig(repoRoot: string): Promise<OsvScannerConfig> {
  const absPath = join(resolve(repoRoot), "osv-scanner.toml");

  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ignoredVulns: [], filePath: null };
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const e = err as { name?: string; line?: number; column?: number; message?: string };
    const line = typeof e.line === "number" ? e.line : 1;
    const column = typeof e.column === "number" ? e.column : 1;
    throw new ConfigParseError(absPath, line, column, e.message ?? String(err));
  }

  const rawEntries = (parsed["IgnoredVulns"] as Array<Record<string, unknown>> | undefined) ?? [];
  const sourceLines = findSourceLines(raw);

  const ignoredVulns: IgnoredVuln[] = rawEntries.map((entry, idx) => {
    const id = String(entry["id"] ?? "");
    const rawUntil = entry["ignoreUntil"];
    const ignoreUntil =
      rawUntil instanceof Date
        ? rawUntil.toISOString().slice(0, 10)
        : String(rawUntil ?? "");
    const reason =
      typeof entry["reason"] === "string" ? entry["reason"] : undefined;
    const sourceLine = sourceLines[idx];
    return { id, ignoreUntil, reason, sourceLine };
  });

  return { ignoredVulns, filePath: absPath };
}

export async function loadDepauditConfig(repoRoot: string): Promise<DepauditConfig> {
  const absPath = join(resolve(repoRoot), ".depaudit.yml");

  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ...DEFAULT_DEPAUDIT_CONFIG, filePath: null };
    }
    throw err;
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter });

  if (doc.errors.length > 0) {
    const parseErr = doc.errors[0];
    const pos = parseErr.pos[0];
    const linePos = lineCounter.linePos(pos);
    throw new ConfigParseError(absPath, linePos.line, linePos.col, parseErr.message);
  }

  const js = doc.toJS() as Record<string, unknown> | null ?? {};

  const version = typeof js["version"] === "number" ? js["version"] : 0;

  const rawPolicy = (js["policy"] as Record<string, unknown> | undefined) ?? {};
  const severityThreshold =
    typeof rawPolicy["severityThreshold"] === "string"
      ? (rawPolicy["severityThreshold"] as string).toLowerCase()
      : DEFAULT_DEPAUDIT_CONFIG.policy.severityThreshold;
  const ecosystems =
    rawPolicy["ecosystems"] !== undefined ? rawPolicy["ecosystems"] as "auto" | string[] : DEFAULT_DEPAUDIT_CONFIG.policy.ecosystems;
  const maxAcceptDays =
    typeof rawPolicy["maxAcceptDays"] === "number" ? rawPolicy["maxAcceptDays"] : DEFAULT_DEPAUDIT_CONFIG.policy.maxAcceptDays;
  const maxCommonAndFineDays =
    typeof rawPolicy["maxCommonAndFineDays"] === "number" ? rawPolicy["maxCommonAndFineDays"] : DEFAULT_DEPAUDIT_CONFIG.policy.maxCommonAndFineDays;

  const cfSeq = doc.get("commonAndFine", true);
  const rawCf = (js["commonAndFine"] as Array<Record<string, unknown>> | undefined) ?? [];
  const commonAndFine: CommonAndFineEntry[] = rawCf.map((entry, idx) => {
    const expires = entry["expires"] instanceof Date
      ? (entry["expires"] as Date).toISOString().slice(0, 10)
      : String(entry["expires"] ?? "");
    let sourceLine: number | undefined;
    if (cfSeq && typeof (cfSeq as { items?: unknown[] }).items !== "undefined") {
      const items = (cfSeq as { items: Array<{ range?: [number, number, number] }> }).items;
      if (items[idx]?.range) {
        const pos = items[idx].range![0];
        sourceLine = lineCounter.linePos(pos).line;
      }
    }
    return {
      package: String(entry["package"] ?? ""),
      alertType: String(entry["alertType"] ?? ""),
      expires,
      reason: typeof entry["reason"] === "string" ? entry["reason"] : undefined,
      sourceLine,
    };
  });

  const scaSeq = doc.get("supplyChainAccepts", true);
  const rawSca = (js["supplyChainAccepts"] as Array<Record<string, unknown>> | undefined) ?? [];
  const supplyChainAccepts: SupplyChainAccept[] = rawSca.map((entry, idx) => {
    const expires = entry["expires"] instanceof Date
      ? (entry["expires"] as Date).toISOString().slice(0, 10)
      : String(entry["expires"] ?? "");
    let sourceLine: number | undefined;
    if (scaSeq && typeof (scaSeq as { items?: unknown[] }).items !== "undefined") {
      const items = (scaSeq as { items: Array<{ range?: [number, number, number] }> }).items;
      if (items[idx]?.range) {
        const pos = items[idx].range![0];
        sourceLine = lineCounter.linePos(pos).line;
      }
    }
    return {
      package: String(entry["package"] ?? ""),
      version: String(entry["version"] ?? ""),
      findingId: String(entry["findingId"] ?? ""),
      expires,
      reason: typeof entry["reason"] === "string" ? entry["reason"] : undefined,
      upstreamIssue: typeof entry["upstreamIssue"] === "string" ? entry["upstreamIssue"] : undefined,
      sourceLine,
    };
  });

  return {
    version,
    policy: {
      severityThreshold: severityThreshold as import("../types/depauditConfig.js").SeverityThreshold,
      ecosystems,
      maxAcceptDays,
      maxCommonAndFineDays,
    },
    commonAndFine,
    supplyChainAccepts,
    filePath: absPath,
  };
}
