import { describe, it, expect, vi } from "vitest";
import { execute, CommitOrPrExecutorError } from "../commitOrPrExecutor.js";

const REPO_ROOT = "/fake/repo";
const REPO = "owner/repo";
const TRIGGER = "main";
const PATHS = [".github/workflows/depaudit-gate.yml", ".depaudit.yml"];

// Helper to build an execFile mock that tracks calls and returns configured responses
function buildExecMock(responses: Record<string, { stdout?: string; stderr?: string; error?: string; code?: number }>) {
  const calls: string[][] = [];
  const exec = async (_file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push([_file, ...args]);
    const key = `${_file} ${args[0]} ${args[1] ?? ""}`.trim();
    const simpleKey = `${_file} ${args[0]}`.trim();

    // Match by specific args pattern
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern) || simpleKey.includes(pattern) || args.join(" ").includes(pattern)) {
        if (response.error !== undefined) {
          throw Object.assign(new Error(response.error), {
            code: response.code ?? 1,
            stderr: response.error,
          });
        }
        return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
      }
    }

    // Default: success with empty output
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("execute — feature branch path (currentBranch !== triggerBranch)", () => {
  it("commits directly, returns kind=commit with sha", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "feature/adopt-depaudit" },
      "rev-parse": { stdout: "abc123" },
    });

    const result = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: TRIGGER, pathsToCommit: PATHS,
      execFile: exec,
    });

    expect(result.kind).toBe("commit");
    if (result.kind === "commit") {
      expect(result.branch).toBe("feature/adopt-depaudit");
      expect(result.commitSha).toBe("abc123");
    }
  });

  it("does not invoke git push", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "feature/x" },
      "rev-parse": { stdout: "sha123" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: TRIGGER, pathsToCommit: PATHS,
      execFile: exec,
    });

    const pushCalls = calls.filter((c) => c[0] === "git" && c.includes("push"));
    expect(pushCalls.length).toBe(0);
  });

  it("does not invoke gh pr create", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "feature/x" },
      "rev-parse": { stdout: "sha123" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: TRIGGER, pathsToCommit: PATHS,
      execFile: exec,
    });

    const prCalls = calls.filter((c) => c[0] === "gh");
    expect(prCalls.length).toBe(0);
  });

  it("commit message contains 'depaudit setup'", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "feature/x" },
      "rev-parse": { stdout: "sha" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: TRIGGER, pathsToCommit: PATHS,
      execFile: exec,
    });

    const commitCall = calls.find((c) => c[0] === "git" && c.includes("commit"));
    expect(commitCall).toBeDefined();
    const mIdx = commitCall!.indexOf("-m");
    expect(commitCall![mIdx + 1]).toContain("depaudit setup");
  });

  it("does NOT pass --no-verify to git commit", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "feature/x" },
      "rev-parse": { stdout: "sha" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: TRIGGER, pathsToCommit: PATHS,
      execFile: exec,
    });

    const commitCall = calls.find((c) => c[0] === "git" && c.includes("commit"));
    expect(commitCall).toBeDefined();
    expect(commitCall!.includes("--no-verify")).toBe(false);
  });

  it("prefix of trigger branch is treated as feature branch", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "mai" },
      "rev-parse": { stdout: "sha" },
    });

    const result = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    });

    expect(result.kind).toBe("commit");
    const prCalls = calls.filter((c) => c[0] === "gh");
    expect(prCalls.length).toBe(0);
  });

  it("branch comparison is case-sensitive", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "Main" },
      "rev-parse": { stdout: "sha" },
    });

    const result = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    });

    expect(result.kind).toBe("commit");
    const prCalls = calls.filter((c) => c[0] === "gh");
    expect(prCalls.length).toBe(0);
  });
});

describe("execute — trigger branch path (currentBranch === triggerBranch)", () => {
  it("creates depaudit-setup branch, pushes, opens PR", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "main" },
      "ls-remote": { stdout: "", stderr: "", error: "no match", code: 2 }, // branch absent
      "gh pr create": { stdout: "https://github.com/owner/repo/pull/1" },
    });

    const result = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    });

    expect(result.kind).toBe("pr");
    if (result.kind === "pr") {
      expect(result.branch).toBe("depaudit-setup");
      expect(result.prUrl).toBe("https://github.com/owner/repo/pull/1");
    }
  });

  it("PR title contains 'depaudit setup'", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "main" },
      "ls-remote": { error: "no match", code: 2 },
      "gh pr create": { stdout: "https://github.com/owner/repo/pull/1" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    });

    const prCall = calls.find((c) => c[0] === "gh" && c.includes("create"));
    expect(prCall).toBeDefined();
    const titleIdx = prCall!.indexOf("--title");
    expect(prCall![titleIdx + 1]).toContain("depaudit setup");
  });

  it("PR base branch matches trigger branch", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "dev" },
      "ls-remote": { error: "no match", code: 2 },
      "gh pr create": { stdout: "https://github.com/owner/repo/pull/2" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "dev", pathsToCommit: PATHS,
      execFile: exec,
    });

    const prCall = calls.find((c) => c[0] === "gh" && c.includes("create"));
    expect(prCall).toBeDefined();
    const baseIdx = prCall!.indexOf("--base");
    expect(prCall![baseIdx + 1]).toBe("dev");
  });

  it("PR head branch is depaudit-setup", async () => {
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "main" },
      "ls-remote": { error: "no match", code: 2 },
      "gh pr create": { stdout: "https://github.com/owner/repo/pull/1" },
    });

    await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    });

    const prCall = calls.find((c) => c[0] === "gh" && c.includes("create"));
    const headIdx = prCall!.indexOf("--head");
    expect(prCall![headIdx + 1]).toBe("depaudit-setup");
  });
});

describe("execute — branch collision suffix", () => {
  it("resolves to depaudit-setup-3 when depaudit-setup and depaudit-setup-2 exist", async () => {
    let lsRemoteCallCount = 0;
    const { exec, calls } = buildExecMock({
      "branch --show-current": { stdout: "main" },
      "gh pr create": { stdout: "https://github.com/owner/repo/pull/1" },
    });

    // Override ls-remote behavior manually
    const customExec = async (file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push([file, ...args]);
      if (file === "git" && args.includes("ls-remote")) {
        lsRemoteCallCount++;
        // First two calls: branch exists (exit 0)
        if (lsRemoteCallCount <= 2) {
          return { stdout: "abc\trefs/heads/branch\n", stderr: "" };
        }
        // Third call: branch absent (exit 2)
        throw Object.assign(new Error("no match"), { code: 2 });
      }
      if (file === "gh" && args.includes("create")) {
        return { stdout: "https://github.com/owner/repo/pull/1", stderr: "" };
      }
      if (file === "git" && args.includes("--show-current")) {
        return { stdout: "main", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: customExec,
    });

    expect(result.kind).toBe("pr");
    if (result.kind === "pr") {
      expect(result.branch).toBe("depaudit-setup-3");
    }
  });
});

describe("execute — failure paths", () => {
  it("throws CommitOrPrExecutorError with stage=commit when git commit fails", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (_file === "git" && args.includes("--show-current")) return { stdout: "feature/x", stderr: "" };
      if (_file === "git" && args.includes("commit")) {
        throw Object.assign(new Error("nothing to commit"), { code: 1, stderr: "git: nothing to commit" });
      }
      return { stdout: "", stderr: "" };
    };

    const err = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CommitOrPrExecutorError);
    expect((err as CommitOrPrExecutorError).stage).toBe("commit");
  });

  it("throws CommitOrPrExecutorError with stage=pr when gh pr create fails", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (_file === "git" && args.includes("--show-current")) return { stdout: "main", stderr: "" };
      if (_file === "git" && args.includes("ls-remote")) {
        throw Object.assign(new Error("no match"), { code: 2 });
      }
      if (_file === "gh" && args.includes("create")) {
        throw Object.assign(new Error("API rate limit"), { code: 1, stderr: "gh: API rate limit" });
      }
      return { stdout: "", stderr: "" };
    };

    const err = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CommitOrPrExecutorError);
    expect((err as CommitOrPrExecutorError).stage).toBe("pr");
  });

  it("throws CommitOrPrExecutorError with stage=branch when branch --show-current fails", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (_file === "git" && args.includes("--show-current")) {
        throw Object.assign(new Error("not a git repository"), { code: 128, stderr: "fatal: not a git repository" });
      }
      return { stdout: "", stderr: "" };
    };

    const err = await execute({
      repoRoot: REPO_ROOT, repo: REPO, triggerBranch: "main", pathsToCommit: PATHS,
      execFile: exec,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CommitOrPrExecutorError);
    expect((err as CommitOrPrExecutorError).stage).toBe("branch");
  });
});
