import { readFile } from "node:fs/promises";
import type { PrComment, PrCoordinates } from "../types/prComment.js";
import {
  listPrComments,
  createPrComment,
  updatePrComment,
  GhApiError,
} from "../modules/ghPrCommentClient.js";
import { decideCommentAction } from "../modules/stateTracker.js";

export interface PostPrCommentOptions {
  bodyFile: string;
  repo?: string;
  prNumber?: number;
  ghClient?: {
    listPrComments: typeof listPrComments;
    createPrComment: typeof createPrComment;
    updatePrComment: typeof updatePrComment;
  };
}

async function resolvePrNumberFromEvent(): Promise<number | null> {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (!eventPath) return null;
  try {
    const raw = await readFile(eventPath, "utf8");
    const json = JSON.parse(raw) as {
      pull_request?: { number?: number };
      number?: number;
    };
    const n = json.pull_request?.number ?? json.number;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

export async function runPostPrCommentCommand(
  options: PostPrCommentOptions
): Promise<number> {
  let body: string;
  try {
    body = await readFile(options.bodyFile, "utf8");
  } catch {
    process.stderr.write(`error: could not read body file '${options.bodyFile}'\n`);
    return 2;
  }

  if (body.length === 0) {
    process.stderr.write(`error: body file is empty\n`);
    return 2;
  }

  const repo = options.repo ?? process.env["GITHUB_REPOSITORY"];
  if (!repo) {
    process.stderr.write(
      `error: repository not set — pass --repo or set GITHUB_REPOSITORY\n`
    );
    return 2;
  }

  const prNumber = options.prNumber ?? (await resolvePrNumberFromEvent());
  if (prNumber === null || prNumber === undefined) {
    process.stderr.write(
      `error: PR number not set — pass --pr or run in a pull_request Actions event\n`
    );
    return 2;
  }

  const client = options.ghClient ?? {
    listPrComments,
    createPrComment,
    updatePrComment,
  };

  let comments: PrComment[];
  try {
    comments = await client.listPrComments({ repo, prNumber });
  } catch (err: unknown) {
    if (err instanceof GhApiError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const action = decideCommentAction(comments, body);

  try {
    if (action.kind === "create") {
      const { id } = await client.createPrComment({ repo, prNumber }, action.body);
      process.stdout.write(`posted new depaudit gate comment (id: ${id})\n`);
    } else {
      await client.updatePrComment(
        { repo, commentId: action.commentId },
        action.body
      );
      process.stdout.write(
        `updated depaudit gate comment (id: ${action.commentId})\n`
      );
    }
  } catch (err: unknown) {
    if (err instanceof GhApiError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  return 0;
}
