import { promisify } from "node:util";
import * as childProcess from "node:child_process";
import type { ExecFileFn } from "./ghPrCommentClient.js";
import { branchExistsOnRemote } from "./gitRemoteResolver.js";

const defaultExecFile: ExecFileFn = promisify(childProcess.execFile) as ExecFileFn;

export type CommitOrPrStage =
  | "branch"
  | "add"
  | "commit"
  | "checkout"
  | "push"
  | "pr"
  | "branch-collision";

export class CommitOrPrExecutorError extends Error {
  constructor(
    message: string,
    public readonly stage: CommitOrPrStage
  ) {
    super(message);
    this.name = "CommitOrPrExecutorError";
  }
}

export type CommitOrPrAction =
  | { kind: "commit"; branch: string; commitSha: string }
  | { kind: "pr"; branch: string; prUrl: string };

export interface CommitOrPrExecutorOptions {
  repoRoot: string;
  repo: string;
  triggerBranch: string;
  pathsToCommit: string[];
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  execFile?: ExecFileFn;
}

async function git(
  exec: ExecFileFn,
  repoRoot: string,
  args: string[],
  stage: CommitOrPrStage
): Promise<string> {
  try {
    const result = await exec("git", ["-C", repoRoot, ...args]);
    return result.stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new CommitOrPrExecutorError(
      `git ${args[0]} failed: ${e.stderr ?? e.message ?? String(err)}`,
      stage
    );
  }
}

export async function execute(
  options: CommitOrPrExecutorOptions
): Promise<CommitOrPrAction> {
  const {
    repoRoot,
    repo,
    triggerBranch,
    pathsToCommit,
    commitMessage = "depaudit setup: bootstrap",
    prTitle = "depaudit setup: bootstrap",
    prBody = "Opened automatically by `depaudit setup`.",
    execFile: exec = defaultExecFile,
  } = options;

  // 1. Get current branch
  const currentBranch = await git(exec, repoRoot, ["branch", "--show-current"], "branch");

  // 2. Stage all files
  await git(exec, repoRoot, ["add", ...pathsToCommit], "add");

  // 3. Feature-branch path: commit directly
  if (currentBranch !== triggerBranch) {
    await git(exec, repoRoot, ["commit", "-m", commitMessage], "commit");
    const commitSha = await git(exec, repoRoot, ["rev-parse", "HEAD"], "commit");
    return { kind: "commit", branch: currentBranch, commitSha };
  }

  // 4. Trigger-branch path: find non-colliding branch name
  let setupBranch = "depaudit-setup";
  let suffix = 2;
  let exists: boolean;
  try {
    exists = await branchExistsOnRemote(repo, setupBranch, { execFile: exec });
  } catch (err: unknown) {
    throw new CommitOrPrExecutorError(
      `branch collision check failed: ${(err as Error).message}`,
      "branch-collision"
    );
  }
  while (exists) {
    setupBranch = `depaudit-setup-${suffix++}`;
    try {
      exists = await branchExistsOnRemote(repo, setupBranch, { execFile: exec });
    } catch (err: unknown) {
      throw new CommitOrPrExecutorError(
        `branch collision check failed: ${(err as Error).message}`,
        "branch-collision"
      );
    }
  }

  // Checkout new branch
  await git(exec, repoRoot, ["checkout", "-b", setupBranch], "checkout");

  // Commit
  await git(exec, repoRoot, ["commit", "-m", commitMessage], "commit");

  // Push
  await git(exec, repoRoot, ["push", "--set-upstream", "origin", setupBranch], "push");

  // Open PR
  let prUrl: string;
  try {
    const result = await exec("gh", [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      triggerBranch,
      "--head",
      setupBranch,
      "--title",
      prTitle,
      "--body",
      prBody,
    ]);
    prUrl = result.stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new CommitOrPrExecutorError(
      `gh pr create failed: ${e.stderr ?? e.message ?? String(err)}`,
      "pr"
    );
  }

  return { kind: "pr", branch: setupBranch, prUrl };
}
