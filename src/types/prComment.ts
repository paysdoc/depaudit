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

/** Outcome of the *current* scan, parsed from the body about to be posted. */
export type CurrentOutcome = "pass" | "fail";

/** Result of computeTransition — describes whether this push is a fail-edge worth a Slack ping. */
export interface SlackTransition {
  /** True iff this push is a fail-edge transition (priorOutcome !== "fail" AND currentOutcome === "fail"). */
  shouldFireSlack: boolean;
  /** Label for telemetry/logging; not a discriminator. */
  label:
    | "first-fail"
    | "pass-to-fail"
    | "fail-to-fail"
    | "pass-to-pass"
    | "fail-to-pass"
    | "first-pass";
}
