import { describe, it, expect } from "vitest";
import { decideCommentAction, readPriorState, outcomeFromBody, computeTransition } from "../stateTracker.js";
import type { PrComment } from "../../types/prComment.js";

const MARKER = "<!-- depaudit-gate-comment -->";

describe("decideCommentAction", () => {
  it("returns create action for empty comment list", () => {
    const result = decideCommentAction([], "new body");
    expect(result).toEqual({ kind: "create", body: "new body" });
  });

  it("returns update action for one marker-bearing comment", () => {
    const comments: PrComment[] = [{ id: 7, body: `${MARKER}\n## depaudit gate: PASS\n` }];
    const result = decideCommentAction(comments, "new body");
    expect(result).toEqual({ kind: "update", commentId: 7, body: "new body" });
  });

  it("finds marker appearing mid-body (not at line 0)", () => {
    const comments: PrComment[] = [
      { id: 3, body: `some preamble\n\n${MARKER}\n## depaudit gate: FAIL\n` },
    ];
    const result = decideCommentAction(comments, "new body");
    expect(result).toEqual({ kind: "update", commentId: 3, body: "new body" });
  });

  it("returns update for FIRST marker-bearing comment when multiple exist", () => {
    const comments: PrComment[] = [
      { id: 10, body: `${MARKER}\nfirst` },
      { id: 20, body: `${MARKER}\nsecond` },
    ];
    const result = decideCommentAction(comments, "new body");
    expect(result).toEqual({ kind: "update", commentId: 10, body: "new body" });
  });

  it("returns create when no comments have the marker", () => {
    const comments: PrComment[] = [
      { id: 1, body: "no marker here" },
      { id: 2, body: "also no marker" },
      { id: 3, body: "still nothing" },
    ];
    const result = decideCommentAction(comments, "new body");
    expect(result).toEqual({ kind: "create", body: "new body" });
  });

  it("returns update for the marker-bearing comment among mixed list", () => {
    const comments: PrComment[] = [
      { id: 1, body: "no marker" },
      { id: 2, body: "no marker" },
      { id: 5, body: `${MARKER}\n## depaudit gate: PASS\n` },
      { id: 6, body: "no marker" },
    ];
    const result = decideCommentAction(comments, "new body");
    expect(result).toEqual({ kind: "update", commentId: 5, body: "new body" });
  });

  it("passes the newBody through byte-for-byte", () => {
    const newBody = "exact bytes: abc123\n\t special!";
    const result = decideCommentAction([], newBody);
    expect(result.body).toBe(newBody);
  });

  it("is pure — same inputs produce same outputs", () => {
    const comments: PrComment[] = [{ id: 1, body: `${MARKER}\nbody` }];
    const r1 = decideCommentAction(comments, "body");
    const r2 = decideCommentAction(comments, "body");
    expect(r1).toEqual(r2);
  });

  it("does not mutate the input array", () => {
    const comments: PrComment[] = [{ id: 1, body: `${MARKER}\nbody` }];
    const before = JSON.stringify(comments);
    decideCommentAction(comments, "new body");
    expect(JSON.stringify(comments)).toBe(before);
  });
});

describe("readPriorState", () => {
  it("returns none for empty comment list (no commentId)", () => {
    const result = readPriorState([]);
    expect(result).toEqual({ priorOutcome: "none" });
  });

  it("detects PASS state from marker-bearing comment", () => {
    const comments: PrComment[] = [
      { id: 99, body: `${MARKER}\n## depaudit gate: PASS\n- new: 0\n` },
    ];
    const result = readPriorState(comments);
    expect(result).toEqual({ priorOutcome: "pass", commentId: 99 });
  });

  it("detects FAIL state from marker-bearing comment", () => {
    const comments: PrComment[] = [
      { id: 42, body: `${MARKER}\n## depaudit gate: FAIL\n- new: 2\n` },
    ];
    const result = readPriorState(comments);
    expect(result).toEqual({ priorOutcome: "fail", commentId: 42 });
  });

  it("returns none with commentId when marker present but no recognisable header", () => {
    const comments: PrComment[] = [
      { id: 55, body: `${MARKER}\nsome unrecognised content\n` },
    ];
    const result = readPriorState(comments);
    expect(result).toEqual({ priorOutcome: "none", commentId: 55 });
  });

  it("uses the FIRST marker-bearing comment's header for multiple markers", () => {
    const comments: PrComment[] = [
      { id: 1, body: `${MARKER}\n## depaudit gate: PASS\n` },
      { id: 2, body: `${MARKER}\n## depaudit gate: FAIL\n` },
    ];
    const result = readPriorState(comments);
    expect(result.priorOutcome).toBe("pass");
    expect(result.commentId).toBe(1);
  });

  it("skips comments without the marker even if they contain PASS text", () => {
    const comments: PrComment[] = [
      { id: 1, body: "depaudit gate: PASS but no marker here" },
    ];
    const result = readPriorState(comments);
    expect(result).toEqual({ priorOutcome: "none" });
  });

  it("is pure — same inputs produce same outputs", () => {
    const comments: PrComment[] = [
      { id: 1, body: `${MARKER}\n## depaudit gate: FAIL\n` },
    ];
    const r1 = readPriorState(comments);
    const r2 = readPriorState(comments);
    expect(r1).toEqual(r2);
  });

  it("does not mutate the input array", () => {
    const comments: PrComment[] = [
      { id: 1, body: `${MARKER}\n## depaudit gate: PASS\n` },
    ];
    const before = JSON.stringify(comments);
    readPriorState(comments);
    expect(JSON.stringify(comments)).toBe(before);
  });
});

describe("outcomeFromBody", () => {
  it("returns 'pass' for body containing 'depaudit gate: PASS'", () => {
    expect(outcomeFromBody("## depaudit gate: PASS\n- new: 0\n")).toBe("pass");
  });

  it("returns 'fail' for body containing 'depaudit gate: FAIL'", () => {
    expect(outcomeFromBody("## depaudit gate: FAIL\n- new: 1\n")).toBe("fail");
  });

  it("returns null for body containing neither header", () => {
    expect(outcomeFromBody("some random markdown\n- item\n")).toBeNull();
  });

  it("returns 'pass' when both PASS and FAIL appear (PASS wins per readPriorState convention)", () => {
    expect(outcomeFromBody("depaudit gate: PASS\ndepaudit gate: FAIL\n")).toBe("pass");
  });

  it("returns null for empty string", () => {
    expect(outcomeFromBody("")).toBeNull();
  });

  it("does not match 'PASS' outside the 'depaudit gate: ' prefix", () => {
    expect(outcomeFromBody("PASS the salt around")).toBeNull();
  });

  it("matches case-sensitively (lowercase 'depaudit gate: pass' returns null)", () => {
    expect(outcomeFromBody("depaudit gate: pass")).toBeNull();
  });
});

describe("computeTransition", () => {
  it("none + fail → first-fail; should fire", () => {
    const result = computeTransition("none", "fail");
    expect(result.shouldFireSlack).toBe(true);
    expect(result.label).toBe("first-fail");
  });

  it("pass + fail → pass-to-fail; should fire", () => {
    const result = computeTransition("pass", "fail");
    expect(result.shouldFireSlack).toBe(true);
    expect(result.label).toBe("pass-to-fail");
  });

  it("fail + fail → fail-to-fail; should NOT fire", () => {
    const result = computeTransition("fail", "fail");
    expect(result.shouldFireSlack).toBe(false);
    expect(result.label).toBe("fail-to-fail");
  });

  it("pass + pass → pass-to-pass; should NOT fire", () => {
    const result = computeTransition("pass", "pass");
    expect(result.shouldFireSlack).toBe(false);
    expect(result.label).toBe("pass-to-pass");
  });

  it("fail + pass → fail-to-pass; should NOT fire", () => {
    const result = computeTransition("fail", "pass");
    expect(result.shouldFireSlack).toBe(false);
    expect(result.label).toBe("fail-to-pass");
  });

  it("none + pass → first-pass; should NOT fire", () => {
    const result = computeTransition("none", "pass");
    expect(result.shouldFireSlack).toBe(false);
    expect(result.label).toBe("first-pass");
  });

  it("is pure — same inputs produce same outputs", () => {
    const r1 = computeTransition("pass", "fail");
    const r2 = computeTransition("pass", "fail");
    expect(r1).toEqual(r2);
  });
});
