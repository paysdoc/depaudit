import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, YAMLMap, YAMLSeq } from "yaml";
import type { SupplyChainAccept } from "../types/depauditConfig.js";
import type { IgnoredVuln } from "../types/osvScannerConfig.js";
import { parse as parseToml } from "smol-toml";

export interface BaselineEntry {
  package: string;
  version: string;
  findingId: string;
  expires: string;
  reason: string;
}

export interface BaselineCveEntry {
  id: string;
  ignoreUntil: string;
  reason: string;
}

/**
 * Removes orphaned supplyChainAccepts entries from a .depaudit.yml file.
 *
 * Uses yaml parseDocument to surgically remove entries while preserving
 * comments and formatting for non-removed entries.
 *
 * @returns the number of entries removed
 */
export async function pruneDepauditYml(
  filePath: string,
  orphans: SupplyChainAccept[]
): Promise<number> {
  if (orphans.length === 0) return 0;

  const raw = await readFile(filePath, "utf8");
  const doc = parseDocument(raw);

  const scaSeq = doc.get("supplyChainAccepts", true) as YAMLSeq | null | undefined;
  if (!scaSeq || !("items" in scaSeq)) return 0;

  // Build a set of orphan keys for fast lookup
  const orphanKeys = new Set<string>(
    orphans.map((o) => `${o.package}|${o.version}|${o.findingId}`)
  );

  const before = scaSeq.items.length;

  // Filter out orphaned items — iterate in reverse to splice safely
  for (let i = scaSeq.items.length - 1; i >= 0; i--) {
    const item = scaSeq.items[i];
    if (!item || typeof item !== "object") continue;
    // Each item is a yaml Map node; get JS values for comparison
    const js = (item as { toJSON?: () => unknown }).toJSON?.() as Record<string, unknown> | undefined;
    if (!js) continue;
    const pkg = String(js["package"] ?? "");
    const version = String(js["version"] ?? "");
    const findingId = String(js["findingId"] ?? "");
    const key = `${pkg}|${version}|${findingId}`;
    if (orphanKeys.has(key)) {
      scaSeq.items.splice(i, 1);
    }
  }

  const removed = before - scaSeq.items.length;
  if (removed === 0) return 0;

  await writeFile(filePath, doc.toString(), "utf8");
  return removed;
}

/**
 * Removes orphaned [[IgnoredVulns]] blocks from an osv-scanner.toml file.
 *
 * Uses a line-range deletion approach rather than TOML stringify to preserve
 * all comments and original formatting for non-removed blocks.
 *
 * @returns the number of entries removed
 */
export async function pruneOsvScannerToml(
  filePath: string,
  orphans: IgnoredVuln[]
): Promise<number> {
  if (orphans.length === 0) return 0;

  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");

  // Find line ranges for each [[IgnoredVulns]] block.
  // A block starts at a "[[IgnoredVulns]]" line and ends at the line before the
  // next "[[IgnoredVulns]]" line (or EOF). We include any trailing blank lines
  // within the block but NOT leading blank lines before the next section header.
  interface BlockRange {
    id: string;
    startLine: number; // 0-indexed, inclusive
    endLine: number;   // 0-indexed, inclusive
  }

  const blocks: BlockRange[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "[[IgnoredVulns]]") {
      // Find the id for this block
      let id = "";
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^\s*id\s*=\s*"([^"]+)"/);
        if (m) {
          id = m[1];
          break;
        }
        // If we hit the next [[IgnoredVulns]] without finding id, stop
        if (lines[j].trim() === "[[IgnoredVulns]]") break;
      }

      // Find the end of this block (line before next [[IgnoredVulns]] or EOF)
      let endLine = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "[[IgnoredVulns]]") {
          endLine = j - 1;
          break;
        }
      }

      blocks.push({ id, startLine: i, endLine });
    }
  }

  // Determine which blocks are orphaned
  const orphanIds = new Set<string>(orphans.map((o) => o.id));
  const blocksToRemove = blocks.filter((b) => orphanIds.has(b.id));
  if (blocksToRemove.length === 0) return 0;

  // Mark lines to remove
  const removeSet = new Set<number>();
  for (const block of blocksToRemove) {
    for (let i = block.startLine; i <= block.endLine; i++) {
      removeSet.add(i);
    }
  }

  // Build the new lines array, then strip excess blank lines that would accumulate
  const newLines = lines.filter((_, i) => !removeSet.has(i));

  // Collapse sequences of 2+ consecutive blank lines into a single blank line
  const collapsed: string[] = [];
  let blankStreak = 0;
  for (const line of newLines) {
    if (line.trim() === "") {
      blankStreak++;
      if (blankStreak <= 1) collapsed.push(line);
    } else {
      blankStreak = 0;
      collapsed.push(line);
    }
  }

  // Remove trailing blank lines at EOF (the final newline is re-added by join)
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") {
    collapsed.pop();
  }

  const newContent = collapsed.join("\n") + (collapsed.length > 0 ? "\n" : "");
  await writeFile(filePath, newContent, "utf8");
  return blocksToRemove.length;
}

/**
 * Appends supply-chain baseline entries to a .depaudit.yml file.
 * Creates supplyChainAccepts sequence if absent.
 * Idempotent: skips entries whose (package, version, findingId) already exist.
 *
 * @returns the number of entries appended
 */
export async function appendDepauditYmlBaseline(
  filePath: string,
  entries: BaselineEntry[]
): Promise<number> {
  if (entries.length === 0) return 0;

  const raw = await readFile(filePath, "utf8");
  const doc = parseDocument(raw);

  let scaSeq = doc.get("supplyChainAccepts", true) as YAMLSeq | null | undefined;
  if (!scaSeq || !("items" in scaSeq)) {
    scaSeq = doc.createNode([]) as YAMLSeq;
    doc.set("supplyChainAccepts", scaSeq);
  }

  // Build set of existing keys for idempotency
  const existingKeys = new Set<string>();
  for (const item of scaSeq.items) {
    if (!item || typeof item !== "object") continue;
    const js = (item as { toJSON?: () => unknown }).toJSON?.() as Record<string, unknown> | undefined;
    if (!js) continue;
    existingKeys.add(`${js["package"]}|${js["version"]}|${js["findingId"]}`);
  }

  let appended = 0;
  for (const entry of entries) {
    const key = `${entry.package}|${entry.version}|${entry.findingId}`;
    if (existingKeys.has(key)) continue;

    const node = doc.createNode({
      package: entry.package,
      version: entry.version,
      findingId: entry.findingId,
      expires: entry.expires,
      reason: entry.reason,
    });
    scaSeq.items.push(node);
    existingKeys.add(key);
    appended++;
  }

  if (appended === 0) return 0;

  await writeFile(filePath, doc.toString(), "utf8");
  return appended;
}

/**
 * Appends CVE baseline entries to an osv-scanner.toml file.
 * Idempotent: skips entries whose id already exists.
 *
 * @returns the number of entries appended
 */
export async function appendOsvScannerTomlBaseline(
  filePath: string,
  entries: BaselineCveEntry[]
): Promise<number> {
  if (entries.length === 0) return 0;

  const raw = await readFile(filePath, "utf8");

  // Parse existing ids for idempotency
  let parsed: Record<string, unknown> = {};
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const existing = (parsed["IgnoredVulns"] as Array<Record<string, unknown>> | undefined) ?? [];
  const existingIds = new Set<string>(existing.map((e) => String(e["id"] ?? "")));

  const toAppend = entries.filter((e) => !existingIds.has(e.id));
  if (toAppend.length === 0) return 0;

  let newContent = raw;
  // Ensure file ends with exactly one newline before appending
  if (!newContent.endsWith("\n")) newContent += "\n";

  for (const entry of toAppend) {
    newContent += `\n[[IgnoredVulns]]\nid = "${entry.id}"\nignoreUntil = ${entry.ignoreUntil}\nreason = "${entry.reason}"\n`;
  }

  await writeFile(filePath, newContent, "utf8");
  return toAppend.length;
}
