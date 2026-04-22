export interface PrComment {
  id: number;
  body: string;
  user?: { login: string };
}

export interface PrCoordinates {
  repo: string; // "owner/repo"
  prNumber: number;
}

export type CommentAction =
  | { kind: "create"; body: string }
  | { kind: "update"; commentId: number; body: string };

export type PriorOutcome = "pass" | "fail" | "none";

export interface PriorState {
  priorOutcome: PriorOutcome;
  commentId?: number;
}
