import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverManifests } from "../modules/manifestDiscoverer.js";
import { resolveRepo, resolveTriggerBranch } from "../modules/gitRemoteResolver.js";
import { installGateWorkflow } from "../modules/templateInstaller.js";
import { appendDepauditYmlBaseline, appendOsvScannerTomlBaseline } from "../modules/configWriter.js";
import { execute as commitOrPrExecute } from "../modules/commitOrPrExecutor.js";
import { GitRemoteError } from "../modules/gitRemoteResolver.js";
import { GhApiError } from "../modules/ghPrCommentClient.js";
import { CommitOrPrExecutorError } from "../modules/commitOrPrExecutor.js";
import type { ExecFileFn } from "../modules/ghPrCommentClient.js";
import type { ScanResult } from "../types/scanResult.js";
import type { Ecosystem } from "../types/finding.js";
import { DEFAULT_DEPAUDIT_CONFIG, SEVERITY_RANK } from "../types/depauditConfig.js";
import type { SeverityThreshold } from "../types/depauditConfig.js";
import { stringify as yamlStringify } from "yaml";

export interface DepauditSetupOptions {
  cwd?: string;
  now?: Date;
  execFile?: ExecFileFn;
  runScan?: (scanPath: string, options?: { format: "markdown" | "text" }) => Promise<ScanResult>;
}

const SEVERITY_THRESHOLD_RANK: Record<SeverityThreshold, number> = {
  medium: SEVERITY_RANK["MEDIUM"],
  high: SEVERITY_RANK["HIGH"],
  critical: SEVERITY_RANK["CRITICAL"],
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

async function appendGitignore(repoRoot: string): Promise<boolean> {
  const gitignorePath = join(repoRoot, ".gitignore");
  const entry = ".depaudit/findings.json";

  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    // file does not exist — we'll create it
  }

  // Idempotency: check if line already present
  const lines = existing.split("\n");
  if (lines.some((l) => l.trim() === entry)) {
    return false; // already present
  }

  // Append (or create)
  const newContent = existing
    ? (existing.endsWith("\n") ? existing + entry + "\n" : existing + "\n" + entry + "\n")
    : entry + "\n";
  await writeFile(gitignorePath, newContent, "utf8");
  return true;
}

async function scaffoldOsvScannerToml(repoRoot: string): Promise<boolean> {
  const path = join(repoRoot, "osv-scanner.toml");
  try {
    await access(path);
    // exists — check if non-empty
    const content = await readFile(path, "utf8");
    if (content.trim().length > 0) return false; // skip non-empty file
  } catch {
    // does not exist — create it
  }
  await writeFile(path, "# OSV Scanner configuration managed by depaudit\n", "utf8");
  return true;
}

async function scaffoldDepauditYml(
  repoRoot: string,
  ecosystems: Ecosystem[]
): Promise<boolean> {
  const path = join(repoRoot, ".depaudit.yml");
  try {
    await access(path);
    return false; // already exists — abort (per spec)
  } catch {
    // does not exist — create it
  }

  const cfg = {
    ...DEFAULT_DEPAUDIT_CONFIG,
    policy: {
      ...DEFAULT_DEPAUDIT_CONFIG.policy,
      ecosystems: ecosystems.length > 0 ? (ecosystems as string[]) : "auto",
    },
    commonAndFine: [],
    supplyChainAccepts: [],
  };

  // Serialize without the filePath sentinel
  const { filePath: _fp, ...rest } = cfg;
  void _fp;

  const content = yamlStringify(rest);
  await writeFile(path, content, "utf8");
  return true;
}

export async function runDepauditSetupCommand(
  options: DepauditSetupOptions = {}
): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  const execFile = options.execFile;

  // Verify .git exists
  try {
    await access(join(cwd, ".git"));
  } catch {
    process.stderr.write(`error: ${cwd} is not a git repository\n`);
    return 2;
  }

  // Resolve repo identifier
  let repo: string;
  try {
    repo = await resolveRepo(cwd, { execFile });
  } catch (err: unknown) {
    if (err instanceof GitRemoteError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  // Discover ecosystems
  let ecosystems: Ecosystem[] = [];
  try {
    const manifests = await discoverManifests(cwd);
    const seen = new Set<Ecosystem>();
    for (const m of manifests) seen.add(m.ecosystem);
    ecosystems = [...seen].sort() as Ecosystem[];
  } catch {
    // non-fatal: discovery failure → stay with "auto"
  }

  // Resolve trigger branch
  let triggerBranch: string;
  try {
    triggerBranch = await resolveTriggerBranch(repo, { execFile });
  } catch (err: unknown) {
    if (err instanceof GhApiError) {
      process.stderr.write(`error: gh: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Track what was scaffolded
  const scaffolded: string[] = [];
  const skipped: string[] = [];

  // Scaffold gate workflow
  let workflowPath: string;
  try {
    const result = await installGateWorkflow(cwd, triggerBranch, { now });
    workflowPath = result.destPath;
    if (result.written) {
      scaffolded.push(".github/workflows/depaudit-gate.yml");
    } else if (result.conflict) {
      process.stderr.write(`error: .github/workflows/depaudit-gate.yml already exists with different content\n`);
      process.stderr.write(`error: depaudit-gate.yml already exists\n`);
      return 1;
    } else {
      skipped.push(".github/workflows/depaudit-gate.yml");
    }
  } catch (err: unknown) {
    process.stderr.write(`error: failed to scaffold workflow: ${(err as Error).message}\n`);
    return 1;
  }

  // Scaffold osv-scanner.toml
  const osvTomlPath = join(cwd, "osv-scanner.toml");
  try {
    const wrote = await scaffoldOsvScannerToml(cwd);
    if (wrote) scaffolded.push("osv-scanner.toml");
    else skipped.push("osv-scanner.toml");
  } catch (err: unknown) {
    process.stderr.write(`error: failed to scaffold osv-scanner.toml: ${(err as Error).message}\n`);
    return 1;
  }

  // Scaffold .depaudit.yml
  const depauditYmlPath = join(cwd, ".depaudit.yml");
  let depauditYmlWrote = false;
  try {
    // Check if it exists first (for the abort-on-existing behavior)
    try {
      await access(depauditYmlPath);
      // exists — abort per spec
      process.stderr.write(`error: .depaudit.yml already exists\n`);
      return 1;
    } catch {
      // does not exist — proceed
    }
    depauditYmlWrote = await scaffoldDepauditYml(cwd, ecosystems);
    if (depauditYmlWrote) scaffolded.push(".depaudit.yml");
    else skipped.push(".depaudit.yml");
  } catch (err: unknown) {
    process.stderr.write(`error: failed to scaffold .depaudit.yml: ${(err as Error).message}\n`);
    return 1;
  }

  // Append to .gitignore
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const appended = await appendGitignore(cwd);
    if (appended) scaffolded.push(".gitignore (appended)");
    else skipped.push(".gitignore (already has entry)");
  } catch (err: unknown) {
    process.stderr.write(`error: failed to update .gitignore: ${(err as Error).message}\n`);
    return 1;
  }

  // Run first scan
  let scanResult: ScanResult;
  try {
    const runScan = options.runScan ?? (await import("./scanCommand.js")).runScanCommand;
    scanResult = await runScan(cwd, { format: "markdown" });
  } catch (err: unknown) {
    process.stderr.write(`error: first scan failed: ${(err as Error).message}\n`);
    // Proceed with empty findings — commit scaffolded files anyway
    scanResult = { findings: [], socketAvailable: false, osvAvailable: false, exitCode: 1 };
  }

  // Baseline new findings at or above threshold
  const threshold: SeverityThreshold = "medium";
  const thresholdRank = SEVERITY_THRESHOLD_RANK[threshold];
  const expires = formatDate(addDays(now, 90));

  const newFindings = scanResult.findings.filter((cf) => cf.category === "new");

  const osvEntries = newFindings
    .filter((cf) => cf.finding.source === "osv" && SEVERITY_RANK[cf.finding.severity] >= thresholdRank)
    .map((cf) => ({
      id: cf.finding.findingId,
      ignoreUntil: expires,
      reason: "baselined at install",
    }));

  const socketEntries = newFindings
    .filter((cf) => cf.finding.source === "socket" && SEVERITY_RANK[cf.finding.severity] >= thresholdRank)
    .map((cf) => ({
      package: cf.finding.package,
      version: cf.finding.version,
      findingId: cf.finding.findingId,
      expires,
      reason: "baselined at install",
    }));

  const expiredAccepts = scanResult.findings.filter((cf) => cf.category === "expired-accept");

  let osvBaselined = 0;
  let socketBaselined = 0;

  try {
    osvBaselined = await appendOsvScannerTomlBaseline(osvTomlPath, osvEntries);
  } catch (err: unknown) {
    process.stderr.write(`error: baseline write (osv-scanner.toml) failed: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    socketBaselined = await appendDepauditYmlBaseline(depauditYmlPath, socketEntries);
  } catch (err: unknown) {
    process.stderr.write(`error: baseline write (.depaudit.yml) failed: ${(err as Error).message}\n`);
    return 1;
  }

  // Collect all changed paths for commit
  const changedPaths: string[] = [
    join(cwd, ".github", "workflows", "depaudit-gate.yml"),
    join(cwd, "osv-scanner.toml"),
    join(cwd, ".depaudit.yml"),
    join(cwd, ".gitignore"),
  ];

  // Commit or open PR
  let action: import("../modules/commitOrPrExecutor.js").CommitOrPrAction;
  const prBody = `This PR was opened automatically by \`depaudit setup\` because setup was invoked while you were on the trigger branch (\`${triggerBranch}\`).

It scaffolds the depaudit gate workflow, adds \`.depaudit.yml\` and \`osv-scanner.toml\`, ensures \`.depaudit/findings.json\` is gitignored, and baselines every existing finding above the configured severity threshold (\`${threshold}\`) with a 90-day acceptance.

Review and merge to enable the depaudit gate on subsequent PRs.`;

  try {
    action = await commitOrPrExecute({
      repoRoot: cwd,
      repo,
      triggerBranch,
      pathsToCommit: changedPaths,
      commitMessage: "depaudit setup: bootstrap",
      prTitle: "depaudit setup: bootstrap",
      prBody,
      execFile,
    });
  } catch (err: unknown) {
    if (err instanceof CommitOrPrExecutorError) {
      process.stderr.write(`error: git/gh failed at stage '${err.stage}': ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
    return 1;
  }

  // Print summary
  const actionLine =
    action.kind === "commit"
      ? `action: commit ${action.commitSha}`
      : `action: pr opened: ${action.prUrl}`;

  const scaffoldedList = scaffolded.map((f) => `  ${f}`).join("\n");
  const expiredLine =
    expiredAccepts.length > 0
      ? `  expired: ${expiredAccepts.length} entries surfaced; re-evaluate manually\n`
      : "";

  process.stdout.write(
    `depaudit setup\n` +
    `──────────────\n` +
    `trigger branch: ${triggerBranch}\n` +
    `scaffolded:\n${scaffoldedList}\n` +
    `baseline:\n` +
    `  osv: ${osvBaselined} entries\n` +
    `  socket: ${socketBaselined} entries\n` +
    expiredLine +
    `${actionLine}\n`
  );

  return 0;
}
