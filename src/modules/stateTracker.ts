import type { PrComment, CommentAction, PriorState, PriorOutcome, CurrentOutcome, SlackTransition } from "../types/prComment.js";
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

export function outcomeFromBody(body: string): CurrentOutcome | null {
  if (body.includes("depaudit gate: PASS")) return "pass";
  if (body.includes("depaudit gate: FAIL")) return "fail";
  return null;
}

export function computeTransition(
  prior: PriorOutcome,
  current: CurrentOutcome
): SlackTransition {
  const shouldFireSlack = current === "fail" && prior !== "fail";
  let label: SlackTransition["label"];
  if (current === "fail") {
    label =
      prior === "none" ? "first-fail" :
      prior === "pass" ? "pass-to-fail" :
                         "fail-to-fail";
  } else {
    label =
      prior === "none" ? "first-pass" :
      prior === "pass" ? "pass-to-pass" :
                         "fail-to-pass";
  }
  return { shouldFireSlack, label };
}
