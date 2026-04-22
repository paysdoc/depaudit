import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPostPrCommentCommand } from "../postPrCommentCommand.js";
import type { PrComment, PrCoordinates } from "../../types/prComment.js";
import type { SlackPostResult } from "../../modules/slackReporter.js";
import { GhApiError } from "../../modules/ghPrCommentClient.js";

const MARKER = "<!-- depaudit-gate-comment -->";
const BODY_WITH_MARKER = `${MARKER}\n## depaudit gate: PASS\n- new: 0\n`;

function makeMockGhClient(initialComments: PrComment[] = []) {
  const state = { comments: [...initialComments], nextId: 100 };
  const log: Array<{ op: string; args: unknown }> = [];
  return {
    state,
    log,
    client: {
      async listPrComments(coords: PrCoordinates) {
        log.push({ op: "list", args: coords });
        return [...state.comments];
      },
      async createPrComment(coords: PrCoordinates, body: string) {
        log.push({ op: "create", args: { coords, body } });
        const id = state.nextId++;
        state.comments.push({ id, body });
        return { id };
      },
      async updatePrComment(
        coords: { repo: string; commentId: number },
        body: string
      ) {
        log.push({ op: "update", args: { coords, body } });
        const idx = state.comments.findIndex((c) => c.id === coords.commentId);
        if (idx !== -1)
          state.comments[idx] = { ...state.comments[idx]!, body };
      },
    },
  };
}

let tempDir: string;
let bodyFile: string;
const REPO = "paysdoc/test-repo";
const PR_NUM = 42;

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "depaudit-test-"));
  bodyFile = join(tempDir, "body.md");
  await writeFile(bodyFile, BODY_WITH_MARKER, "utf8");
  savedEnv = {
    GITHUB_REPOSITORY: process.env["GITHUB_REPOSITORY"],
    GITHUB_EVENT_PATH: process.env["GITHUB_EVENT_PATH"],
  };
  delete process.env["GITHUB_REPOSITORY"];
  delete process.env["GITHUB_EVENT_PATH"];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("runPostPrCommentCommand", () => {
  it("first run with empty comment list calls createPrComment and returns 0", async () => {
    const mock = makeMockGhClient([]);
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
    });
    expect(code).toBe(0);
    expect(mock.log.filter((e) => e.op === "list")).toHaveLength(1);
    expect(mock.log.filter((e) => e.op === "create")).toHaveLength(1);
    expect(mock.log.filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("second run with existing marker comment calls updatePrComment and returns 0", async () => {
    const existing: PrComment[] = [
      { id: 77, body: BODY_WITH_MARKER },
    ];
    const mock = makeMockGhClient(existing);
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
    });
    expect(code).toBe(0);
    expect(mock.log.filter((e) => e.op === "update")).toHaveLength(1);
    expect(mock.log.filter((e) => e.op === "create")).toHaveLength(0);
    const update = mock.log.find((e) => e.op === "update")!;
    expect((update.args as { coords: { commentId: number } }).coords.commentId).toBe(77);
  });

  it("five consecutive runs produce 1 create + 4 updates and exactly 1 comment", async () => {
    const mock = makeMockGhClient([]);
    const opts = { bodyFile, repo: REPO, prNumber: PR_NUM, ghClient: mock.client };
    for (let i = 0; i < 5; i++) {
      await runPostPrCommentCommand(opts);
    }
    expect(mock.log.filter((e) => e.op === "create")).toHaveLength(1);
    expect(mock.log.filter((e) => e.op === "update")).toHaveLength(4);
    expect(mock.state.comments).toHaveLength(1);
  });

  it("returns 2 when GITHUB_REPOSITORY is unset and no --repo provided", async () => {
    const mock = makeMockGhClient([]);
    const code = await runPostPrCommentCommand({
      bodyFile,
      prNumber: PR_NUM,
      ghClient: mock.client,
    });
    expect(code).toBe(2);
  });

  it("returns 2 with GITHUB_REPOSITORY mention when repo missing", async () => {
    let stderrOut = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      stderrOut += s.toString();
      return true;
    };
    const mock = makeMockGhClient([]);
    await runPostPrCommentCommand({ bodyFile, prNumber: PR_NUM, ghClient: mock.client });
    process.stderr.write = origWrite;
    expect(stderrOut).toContain("GITHUB_REPOSITORY");
  });

  it("returns 2 when PR number is missing", async () => {
    const mock = makeMockGhClient([]);
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      ghClient: mock.client,
    });
    expect(code).toBe(2);
  });

  it("returns 2 with pull_request mention when PR number missing", async () => {
    let stderrOut = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      stderrOut += s.toString();
      return true;
    };
    const mock = makeMockGhClient([]);
    await runPostPrCommentCommand({ bodyFile, repo: REPO, ghClient: mock.client });
    process.stderr.write = origWrite;
    expect(stderrOut).toContain("pull_request");
  });

  it("returns 1 when listPrComments throws GhApiError", async () => {
    const client = {
      async listPrComments() {
        throw new GhApiError("auth failed", 1);
      },
      async createPrComment() {
        return { id: 1 };
      },
      async updatePrComment() {},
    };
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: client,
    });
    expect(code).toBe(1);
  });

  it("returns 1 when createPrComment throws GhApiError", async () => {
    const client = {
      async listPrComments() {
        return [] as PrComment[];
      },
      async createPrComment() {
        throw new GhApiError("create failed", 1);
      },
      async updatePrComment() {},
    };
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: client,
    });
    expect(code).toBe(1);
  });

  it("returns 2 when body file does not exist", async () => {
    const mock = makeMockGhClient([]);
    const code = await runPostPrCommentCommand({
      bodyFile: join(tempDir, "nonexistent.md"),
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
    });
    expect(code).toBe(2);
  });

  it("returns 2 when body file is empty", async () => {
    const emptyFile = join(tempDir, "empty.md");
    await writeFile(emptyFile, "", "utf8");
    const mock = makeMockGhClient([]);
    const code = await runPostPrCommentCommand({
      bodyFile: emptyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
    });
    expect(code).toBe(2);
  });

  it("resolves PR number from GITHUB_EVENT_PATH", async () => {
    const eventFile = join(tempDir, "event.json");
    await writeFile(eventFile, JSON.stringify({ pull_request: { number: 42 } }), "utf8");
    process.env["GITHUB_EVENT_PATH"] = eventFile;
    const mock = makeMockGhClient([]);
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      ghClient: mock.client,
    });
    expect(code).toBe(0);
    const listCall = mock.log.find((e) => e.op === "list")!;
    expect((listCall.args as { prNumber: number }).prNumber).toBe(42);
  });
});

// ─── Slack notification tests ─────────────────────────────────────────────────

const FAIL_BODY = `${MARKER}\n## depaudit gate: FAIL\n- new: 1\n`;
const PASS_BODY = `${MARKER}\n## depaudit gate: PASS\n- new: 0\n`;

function makeMockSlackReporter(behaviour?: {
  posted?: boolean;
  reason?: string;
  throws?: Error;
}) {
  const calls: Array<{ text: string }> = [];
  return {
    calls,
    reporter: {
      async postSlackNotification(text: string): Promise<SlackPostResult> {
        calls.push({ text });
        if (behaviour?.throws) throw behaviour.throws;
        return {
          posted: behaviour?.posted ?? true,
          ...(behaviour?.reason ? { reason: behaviour.reason } : {}),
        };
      },
    },
  };
}

describe("Slack notification", () => {
  let stdoutLines: string[];
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutLines = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      stdoutLines.push(s.toString());
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = origWrite;
  });

  it("first-fail: no prior comment, FAIL body fires Slack with PR reference", async () => {
    await writeFile(bodyFile, FAIL_BODY, "utf8");
    const mock = makeMockGhClient([]);
    const slack = makeMockSlackReporter();
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]!.text).toContain("PR #42");
    expect(slack.calls[0]!.text).toContain(
      `https://github.com/${REPO}/pull/${PR_NUM}`
    );
  });

  it("sustained fail: prior FAIL comment + FAIL body does NOT fire Slack", async () => {
    await writeFile(bodyFile, FAIL_BODY, "utf8");
    const mock = makeMockGhClient([{ id: 1, body: FAIL_BODY }]);
    const slack = makeMockSlackReporter();
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("pass-to-fail: prior PASS comment + FAIL body fires Slack", async () => {
    await writeFile(bodyFile, FAIL_BODY, "utf8");
    const mock = makeMockGhClient([{ id: 1, body: PASS_BODY }]);
    const slack = makeMockSlackReporter();
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(1);
  });

  it("fail-to-pass: prior FAIL comment + PASS body does NOT fire Slack", async () => {
    await writeFile(bodyFile, PASS_BODY, "utf8");
    const mock = makeMockGhClient([{ id: 1, body: FAIL_BODY }]);
    const slack = makeMockSlackReporter();
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("sustained pass: prior PASS comment + PASS body does NOT fire Slack", async () => {
    await writeFile(bodyFile, PASS_BODY, "utf8");
    const mock = makeMockGhClient([{ id: 1, body: PASS_BODY }]);
    const slack = makeMockSlackReporter();
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("none-to-pass: no prior comment + PASS body does NOT fire Slack", async () => {
    await writeFile(bodyFile, PASS_BODY, "utf8");
    const mock = makeMockGhClient([]);
    const slack = makeMockSlackReporter();
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("multi-run: fail,fail,pass,fail,fail produces exactly 2 Slack calls", async () => {
    const mock = makeMockGhClient([]);
    const slack = makeMockSlackReporter();
    const bodies = [FAIL_BODY, FAIL_BODY, PASS_BODY, FAIL_BODY, FAIL_BODY];
    for (const b of bodies) {
      await writeFile(bodyFile, b, "utf8");
      await runPostPrCommentCommand({
        bodyFile,
        repo: REPO,
        prNumber: PR_NUM,
        ghClient: mock.client,
        slackReporter: slack.reporter,
      });
    }
    expect(slack.calls).toHaveLength(2);
  });

  it("body without recognisable header skips Slack with stdout breadcrumb", async () => {
    const randomBody = "some random markdown without gate header\n";
    await writeFile(bodyFile, randomBody, "utf8");
    const mock = makeMockGhClient([]);
    const slack = makeMockSlackReporter();
    await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(slack.calls).toHaveLength(0);
    const combined = stdoutLines.join("");
    expect(combined).toContain("no recognisable PASS/FAIL header");
  });

  it("Slack returns posted:false — exit code stays 0, stdout shows reason", async () => {
    await writeFile(bodyFile, FAIL_BODY, "utf8");
    const mock = makeMockGhClient([]);
    const slack = makeMockSlackReporter({
      posted: false,
      reason: "webhook returned 503",
    });
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    expect(slack.calls).toHaveLength(1);
    const combined = stdoutLines.join("");
    expect(combined).toContain("webhook returned 503");
  });

  it("Slack throws — exit code stays 0, stdout shows unexpected error", async () => {
    await writeFile(bodyFile, FAIL_BODY, "utf8");
    const mock = makeMockGhClient([]);
    const slack = makeMockSlackReporter({ throws: new Error("boom") });
    const code = await runPostPrCommentCommand({
      bodyFile,
      repo: REPO,
      prNumber: PR_NUM,
      ghClient: mock.client,
      slackReporter: slack.reporter,
    });
    expect(code).toBe(0);
    const combined = stdoutLines.join("");
    expect(combined).toContain("unexpected error: boom");
  });
});
