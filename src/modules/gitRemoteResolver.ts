import { promisify } from "node:util";
import * as childProcess from "node:child_process";
import type { ExecFileFn } from "./ghPrCommentClient.js";
import { GhApiError } from "./ghPrCommentClient.js";

export { ExecFileFn };

const defaultExecFile: ExecFileFn = promisify(childProcess.execFile) as ExecFileFn;

export class GitRemoteError extends Error {
  constructor(
    message: string,
    public readonly originalUrl?: string
  ) {
    super(message);
    this.name = "GitRemoteError";
  }
}

export interface GitRemoteResolverOptions {
  execFile?: ExecFileFn;
}

export async function resolveRepo(
  repoRoot: string,
  opts: GitRemoteResolverOptions = {}
): Promise<string> {
  const exec = opts.execFile ?? defaultExecFile;
  let stdout: string;
  try {
    const result = await exec("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
    stdout = result.stdout.trim();
  } catch (err: unknown) {
    const e = err as { message?: string };
    throw new GitRemoteError(
      `could not get origin remote URL: ${e.message ?? String(err)}`
    );
  }

  const url = stdout;

  // SSH: git@github.com:owner/name.git
  const sshMatch = url.match(/^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/owner/name.git or https://github.com/owner/name
  const httpsMatch = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  throw new GitRemoteError(
    `could not resolve owner/name from remote URL`,
    url
  );
}

export async function resolveTriggerBranch(
  repo: string,
  opts: GitRemoteResolverOptions = {}
): Promise<string> {
  const exec = opts.execFile ?? defaultExecFile;

  // Try main first
  try {
    await exec("gh", ["api", `repos/${repo}/branches/main`]);
    return "main";
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr ?? e.message ?? "";
    if (!stderr.includes("HTTP 404") && !stderr.includes("404")) {
      throw new GhApiError(
        `gh api branches/main failed: ${e.message ?? String(err)}`,
        1
      );
    }
    // 404 → fall through to default branch
  }

  // Fall back to default branch
  try {
    const result = await exec("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"]);
    return result.stdout.trim();
  } catch (err: unknown) {
    const e = err as { message?: string };
    throw new GhApiError(
      `gh api default_branch failed: ${e.message ?? String(err)}`,
      1
    );
  }
}

export async function branchExistsOnRemote(
  repo: string,
  branch: string,
  opts: GitRemoteResolverOptions = {}
): Promise<boolean> {
  const exec = opts.execFile ?? defaultExecFile;
  try {
    await exec("git", ["ls-remote", "--exit-code", "origin", branch]);
    return true;
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e.code === 2) return false;
    // Other errors are unexpected
    throw err;
  }
}
