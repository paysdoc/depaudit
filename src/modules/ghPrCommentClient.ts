import { promisify } from "node:util";
import * as childProcess from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PrComment, PrCoordinates } from "../types/prComment.js";

export type ExecFileFn = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(childProcess.execFile) as ExecFileFn;

export interface GhPrCommentClientOptions {
  execFile?: ExecFileFn;
}

export class GhApiError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number
  ) {
    super(message);
    this.name = "GhApiError";
  }
}

export async function listPrComments(
  coords: PrCoordinates,
  options: GhPrCommentClientOptions = {}
): Promise<PrComment[]> {
  const exec = options.execFile ?? defaultExecFile;
  let stdout: string;
  try {
    const result = await exec("gh", [
      "api",
      `repos/${coords.repo}/issues/${coords.prNumber}/comments`,
      "--paginate",
    ]);
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { code?: number; message?: string };
    throw new GhApiError(
      `gh api listPrComments failed: ${e.message ?? String(err)}`,
      e.code ?? 1
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GhApiError("gh api listPrComments: malformed JSON response", 1);
  }
  if (!Array.isArray(parsed)) {
    throw new GhApiError("gh api listPrComments: expected JSON array", 1);
  }
  return (parsed as Record<string, unknown>[]).map((el) => ({
    id: Number(el["id"]),
    body: String(el["body"] ?? ""),
    user: el["user"]
      ? { login: String((el["user"] as Record<string, unknown>)["login"] ?? "") }
      : undefined,
  }));
}

export async function createPrComment(
  coords: PrCoordinates,
  body: string,
  options: GhPrCommentClientOptions = {}
): Promise<{ id: number }> {
  const exec = options.execFile ?? defaultExecFile;
  const tempDir = await mkdtemp(join(tmpdir(), "depaudit-gh-body-"));
  const tempFile = join(tempDir, "body.md");
  try {
    await writeFile(tempFile, body, "utf8");
    let stdout: string;
    try {
      const result = await exec("gh", [
        "api",
        `repos/${coords.repo}/issues/${coords.prNumber}/comments`,
        "--method",
        "POST",
        `--field`,
        `body=@${tempFile}`,
      ]);
      stdout = result.stdout;
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      throw new GhApiError(
        `gh api createPrComment failed: ${e.message ?? String(err)}`,
        e.code ?? 1
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new GhApiError("gh api createPrComment: malformed JSON response", 1);
    }
    return { id: Number((parsed as Record<string, unknown>)["id"]) };
  } finally {
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

export async function updatePrComment(
  coords: { repo: string; commentId: number },
  body: string,
  options: GhPrCommentClientOptions = {}
): Promise<void> {
  const exec = options.execFile ?? defaultExecFile;
  const tempDir = await mkdtemp(join(tmpdir(), "depaudit-gh-body-"));
  const tempFile = join(tempDir, "body.md");
  try {
    await writeFile(tempFile, body, "utf8");
    try {
      await exec("gh", [
        "api",
        `repos/${coords.repo}/issues/comments/${coords.commentId}`,
        "--method",
        "PATCH",
        `--field`,
        `body=@${tempFile}`,
      ]);
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      throw new GhApiError(
        `gh api updatePrComment failed: ${e.message ?? String(err)}`,
        e.code ?? 1
      );
    }
  } finally {
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}
