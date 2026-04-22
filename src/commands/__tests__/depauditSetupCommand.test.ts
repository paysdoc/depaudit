import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { runDepauditSetupCommand } from "../depauditSetupCommand.js";
import type { ScanResult } from "../../types/scanResult.js";
import type { ClassifiedFinding } from "../../types/depauditConfig.js";
import type { Finding } from "../../types/finding.js";
import type { ExecFileFn } from "../../modules/ghPrCommentClient.js";

const execFileAsync = promisify(execFileCb);

function makeOsvFinding(id: string = "CVE-TEST-0001"): Finding {
  return {
    source: "osv",
    ecosystem: "npm",
    package: "vuln-pkg",
    version: "1.0.0",
    findingId: id,
    severity: "MEDIUM",
    manifestPath: "package.json",
  };
}

function makeSocketFinding(pkg = "socket-pkg", version = "2.0.0"): Finding {
  return {
    source: "socket",
    ecosystem: "npm",
    package: pkg,
    version,
    findingId: "install-scripts",
    severity: "MEDIUM",
    manifestPath: "package.json",
  };
}

function makeScanResult(findings: ClassifiedFinding[]): ScanResult {
  return { findings, socketAvailable: true, osvAvailable: true, exitCode: findings.some((f) => f.category === "new") ? 1 : 0 };
}

/** Build an execFile mock that simulates git and gh responses */
function buildExecMock(opts: {
  currentBranch?: string;
  originUrl?: string;
  triggerBranch?: string;
  prUrl?: string;
}) {
  const calls: string[][] = [];
  const exec: ExecFileFn = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);

    if (file === "git") {
      if (args.includes("--show-current")) return { stdout: opts.currentBranch ?? "feature/test", stderr: "" };
      if (args.includes("get-url")) return { stdout: opts.originUrl ?? "https://github.com/owner/repo.git", stderr: "" };
      if (args.includes("ls-remote")) throw Object.assign(new Error("no match"), { code: 2 });
      return { stdout: "", stderr: "" };
    }

    if (file === "gh") {
      if (args.some((a) => a.includes("branches/main"))) {
        // Simulate main exists unless trigger is something else
        if (opts.triggerBranch && opts.triggerBranch !== "main") {
          throw Object.assign(new Error("HTTP 404"), { stderr: "HTTP 404", code: 1 });
        }
        return { stdout: '{"name":"main"}', stderr: "" };
      }
      if (args.includes("--jq")) return { stdout: (opts.triggerBranch ?? "main") + "\n", stderr: "" };
      if (args.includes("create")) return { stdout: opts.prUrl ?? "https://github.com/owner/repo/pull/1", stderr: "" };
      return { stdout: "", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "depaudit-setup-test-"));
  // Initialise a fake git repository
  await mkdir(join(repoRoot, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("runDepauditSetupCommand — feature-branch path", () => {
  it("scaffolds all expected files and returns exit code 0", async () => {
    const { exec } = buildExecMock({ currentBranch: "feature/test" });

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () => makeScanResult([]),
    });

    expect(code).toBe(0);
    await access(join(repoRoot, ".github/workflows/depaudit-gate.yml")); // throws ENOENT if missing
    await access(join(repoRoot, "osv-scanner.toml"));
    await access(join(repoRoot, ".depaudit.yml"));
    await access(join(repoRoot, ".gitignore"));
  });

  it("baselines one OSV finding into osv-scanner.toml", async () => {
    const { exec } = buildExecMock({ currentBranch: "feature/test" });

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () =>
        makeScanResult([{ finding: makeOsvFinding(), category: "new" }]),
    });

    expect(code).toBe(0);
    const toml = await readFile(join(repoRoot, "osv-scanner.toml"), "utf8");
    expect(toml).toContain("CVE-TEST-0001");
    expect(toml).toContain("baselined at install");
  });

  it("baselines one Socket finding into .depaudit.yml", async () => {
    const { exec } = buildExecMock({ currentBranch: "feature/test" });

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () =>
        makeScanResult([{ finding: makeSocketFinding(), category: "new" }]),
    });

    expect(code).toBe(0);
    const yml = await readFile(join(repoRoot, ".depaudit.yml"), "utf8");
    expect(yml).toContain("socket-pkg");
    expect(yml).toContain("baselined at install");
  });

  it("uses commit path (not PR) when on feature branch", async () => {
    const { exec, calls } = buildExecMock({ currentBranch: "feature/test" });

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () => makeScanResult([]),
    });

    expect(code).toBe(0);
    const commitCalls = calls.filter((c) => c[0] === "git" && c.includes("commit"));
    expect(commitCalls.length).toBeGreaterThan(0);
    const prCalls = calls.filter((c) => c[0] === "gh" && c.includes("create"));
    expect(prCalls.length).toBe(0);
  });
});

describe("runDepauditSetupCommand — trigger-branch path", () => {
  it("opens PR when current branch is trigger branch", async () => {
    const { exec, calls } = buildExecMock({ currentBranch: "main", triggerBranch: "main" });

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () => makeScanResult([]),
    });

    expect(code).toBe(0);
    const prCalls = calls.filter((c) => c[0] === "gh" && c.includes("create"));
    expect(prCalls.length).toBeGreaterThan(0);
  });
});

describe("runDepauditSetupCommand — error paths", () => {
  it("returns 2 when path is not a git repository", async () => {
    // No .git directory
    const notRepo = await mkdtemp(join(tmpdir(), "depaudit-not-git-"));
    const code = await runDepauditSetupCommand({ cwd: notRepo });
    await rm(notRepo, { recursive: true, force: true });
    expect(code).toBe(2);
  });

  it("returns 1 when .depaudit.yml already exists", async () => {
    const { exec } = buildExecMock({ currentBranch: "feature/test" });
    // Pre-create the file
    await writeFile(join(repoRoot, ".depaudit.yml"), "version: 1\n", "utf8");

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () => makeScanResult([]),
    });

    expect(code).toBe(1);
  });

  it("returns 1 when gh api fails (non-404)", async () => {
    const exec: ExecFileFn = async (file, args) => {
      if (file === "git" && args.includes("get-url")) return { stdout: "https://github.com/owner/repo.git", stderr: "" };
      if (file === "gh" && args.some((a) => a.includes("branches/main"))) {
        throw Object.assign(new Error("HTTP 403 Forbidden"), { stderr: "HTTP 403: Forbidden", code: 1 });
      }
      return { stdout: "", stderr: "" };
    };

    const code = await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () => makeScanResult([]),
    });

    expect(code).toBe(1);
  });
});

describe("runDepauditSetupCommand — .gitignore idempotency", () => {
  it("does not duplicate .depaudit/findings.json entry", async () => {
    const { exec } = buildExecMock({ currentBranch: "feature/test" });

    // First run
    await runDepauditSetupCommand({
      cwd: repoRoot,
      execFile: exec,
      runScan: async () => makeScanResult([]),
    });

    const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
    const count = (gitignore.match(/\.depaudit\/findings\.json/g) ?? []).length;
    expect(count).toBe(1);
  });
});
