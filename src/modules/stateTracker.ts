import type { PrComment, CommentAction, PriorState } from "../types/prComment.js";
import { MARKDOWN_COMMENT_MARKER } from "../types/markdownReport.js";

export function decideCommentAction(
  comments: PrComment[],
  newBody: string
): CommentAction {
  // NB: If multiple comments carry the marker (e.g. from a prior buggy run),
  // update the FIRST one and leave the rest orphaned — cleanup is out of scope.
  const existing = comments.find((c) => c.body.includes(MARKDOWN_COMMENT_MARKER));
  if (existing) {
    return { kind: "update", commentId: existing.id, body: newBody };
  }
  return { kind: "create", body: newBody };
}

export function readPriorState(comments: PrComment[]): PriorState {
  const existing = comments.find((c) => c.body.includes(MARKDOWN_COMMENT_MARKER));
  if (!existing) return { priorOutcome: "none" };
  if (existing.body.includes("depaudit gate: PASS")) {
    return { priorOutcome: "pass", commentId: existing.id };
  }
  if (existing.body.includes("depaudit gate: FAIL")) {
    return { priorOutcome: "fail", commentId: existing.id };
  }
  // Marker-bearing but no recognisable header — commentId preserved for deduplication.
  return { priorOutcome: "none", commentId: existing.id };
}
