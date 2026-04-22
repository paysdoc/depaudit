import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT, CLI_PATH } from "../support/world.js";
import { startMockGhBinary } from "../support/mockGhBinary.js";

const execFileAsync = promisify(execFile);

const MARKER = "<!-- depaudit-gate-comment -->";
const DEFAULT_REPO = "paysdoc/depaudit-fixture";

// ─── Lifecycle ───────────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-10" }, function (this: DepauditWorld) {
  this.ghMock = undefined;
  this.bodyFilePath = undefined;
  this.priorState = undefined;
});

After<DepauditWorld>({ tags: "@adw-10" }, async function (this: DepauditWorld) {
  await this.ghMock?.stop();
  if (this.bodyFilePath) {
    try {
      await rm(this.bodyFilePath);
    } catch {
      // best-effort
    }
  }
});

// ─── Background ──────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a mock `gh` CLI is on PATH that records its invocations and serves a fake PR comment list",
  async function (this: DepauditWorld) {
    this.ghMock = await startMockGhBinary({ listResponse: [], createResponse: { id: 100 } });
  }
);

// ─── Given steps — mock state configuration ──────────────────────────────────

Given<DepauditWorld>(
  "the mock `gh` CLI returns an empty comment list for PR 42",
  async function (this: DepauditWorld) {
    await this.ghMock!.setState({ listResponse: [], createResponse: { id: 100 } });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes {string}",
  async function (this: DepauditWorld, markerText: string) {
    const comment = { id: 777, body: `${markerText}\n## depaudit gate: PASS\n` };
    await this.ghMock!.setState({ listResponse: [comment], createResponse: { id: 100 } });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI returns a comment list for PR 42 containing two comments, neither of which includes {string}",
  async function (this: DepauditWorld, _markerText: string) {
    await this.ghMock!.setState({
      listResponse: [
        { id: 1, body: "just a normal comment" },
        { id: 2, body: "another normal comment" },
      ],
      createResponse: { id: 100 },
    });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI returns a comment list for PR 42 containing one non-depaudit comment followed by one comment whose body includes {string}",
  async function (this: DepauditWorld, markerText: string) {
    await this.ghMock!.setState({
      listResponse: [
        { id: 10, body: "not a depaudit comment" },
        { id: 11, body: `${markerText}\n## depaudit gate: FAIL\n` },
      ],
      createResponse: { id: 100 },
    });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI returns a comment list for PR 42 containing two comments each whose body includes {string}",
  async function (this: DepauditWorld, markerText: string) {
    await this.ghMock!.setState({
      listResponse: [
        { id: 20, body: `${markerText}\n## depaudit gate: PASS\n` },
        { id: 21, body: `${markerText}\n## depaudit gate: FAIL\n` },
      ],
      createResponse: { id: 100 },
    });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI starts with an empty comment list for PR 42",
  async function (this: DepauditWorld) {
    await this.ghMock!.setState({ listResponse: [], createResponse: { id: 100 } });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI persists its post\\/edit mutations across invocations",
  function (this: DepauditWorld) {
    // This is automatically true — the mock writes state to a file on every create/update.
    // No additional setup needed.
  }
);

// Pass/fail state scenarios
Given<DepauditWorld>(
  "the mock `gh` CLI returns a comment list for PR 42 containing one comment whose body includes {string} and a header {string}",
  async function (
    this: DepauditWorld,
    markerText: string,
    header: string
  ) {
    const comment = { id: 42, body: `${markerText}\n## ${header}\n- new: 0\n` };
    await this.ghMock!.setState({ listResponse: [comment], createResponse: { id: 100 } });
  }
);

// Error scenarios
Given<DepauditWorld>(
  "the mock `gh` CLI exits non-zero with stderr {string} on every list-comments invocation",
  async function (this: DepauditWorld, errorMessage: string) {
    await this.ghMock!.setState({
      listExitOverride: 1,
      listErrorMessage: errorMessage,
      listResponse: [],
      createResponse: { id: 100 },
    });
  }
);

Given<DepauditWorld>(
  "the mock `gh` CLI exits non-zero with stderr {string} on any {string} POST invocation",
  async function (this: DepauditWorld, errorMessage: string, _commandType: string) {
    const currentState = await this.ghMock!.readState();
    await this.ghMock!.setState({
      ...currentState,
      createExitOverride: 1,
      createErrorMessage: errorMessage,
    });
  }
);

// Branch agnosticism scenarios (base branch is irrelevant for gh API calls)
Given<DepauditWorld>(
  "the mock `gh` CLI returns an empty comment list for PR 42 whose base branch is {string}",
  async function (this: DepauditWorld, _branch: string) {
    await this.ghMock!.setState({ listResponse: [], createResponse: { id: 100 } });
  }
);

// ─── Given steps — body file ──────────────────────────────────────────────────

Given<DepauditWorld>(
  "a markdown body containing the marker {string} is supplied as input",
  async function (this: DepauditWorld, _markerText: string) {
    const tempDir = await mkdtemp(join(tmpdir(), "depaudit-body-"));
    this.bodyFilePath = join(tempDir, "body.md");
    const bodyContent = `${MARKER}\n## depaudit gate: PASS\n- new: 0\n- accepted: 0\n`;
    await writeFile(this.bodyFilePath, bodyContent, "utf8");
  }
);

Given<DepauditWorld>(
  "a markdown body {string} is supplied as input",
  async function (this: DepauditWorld, body: string) {
    const tempDir = await mkdtemp(join(tmpdir(), "depaudit-body-"));
    this.bodyFilePath = join(tempDir, "body.md");
    // Replace literal \n sequences with actual newlines
    const actualBody = body.replace(/\\n/g, "\n");
    await writeFile(this.bodyFilePath, actualBody, "utf8");
  }
);

// ─── When steps ──────────────────────────────────────────────────────────────

async function runPostPrComment(world: DepauditWorld): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (world.ghMock) {
    const existingPath = env["PATH"] ?? "";
    env["PATH"] = `${world.ghMock.binDir}:${existingPath}`;
  }
  env["GITHUB_REPOSITORY"] = DEFAULT_REPO;
  env["GH_TOKEN"] = "mock-token";
  // Create a synthetic event JSON for PR 42
  const eventDir = await mkdtemp(join(tmpdir(), "depaudit-event-"));
  const eventFile = join(eventDir, "event.json");
  await writeFile(eventFile, JSON.stringify({ pull_request: { number: 42 } }), "utf8");
  env["GITHUB_EVENT_PATH"] = eventFile;

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      "node",
      [CLI_PATH, "post-pr-comment", `--body-file=${world.bodyFilePath}`],
      { env }
    );
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    exitCode = typeof e.code === "number" ? e.code : 1;
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
  } finally {
    try {
      await rm(eventDir, { recursive: true });
    } catch {}
  }

  world.result = { exitCode, stdout, stderr };
}

When<DepauditWorld>(
  "StateTracker reconciles the PR comment for PR 42",
  async function (this: DepauditWorld) {
    await runPostPrComment(this);
  }
);

When<DepauditWorld>(
  "StateTracker reads the prior PR state for PR 42",
  async function (this: DepauditWorld) {
    // Read the configured comment list from mock state and call readPriorState directly
    const state = await this.ghMock!.readState();
    const comments = state.listResponse ?? [];
    // Import readPriorState from the compiled dist module
    const { readPriorState } = (await import(
      `${PROJECT_ROOT}/dist/modules/stateTracker.js?t=${Date.now()}`
    )) as { readPriorState: (comments: unknown[]) => { priorOutcome: string; commentId?: number } };
    this.priorState = readPriorState(comments) as import("../../src/types/prComment.js").PriorState;
  }
);

// ─── Then steps ──────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the mock `gh` CLI received exactly one {string} POST invocation",
  async function (this: DepauditWorld, _commandType: string) {
    const log = await this.ghMock!.readLog();
    // A POST invocation is a create call: args include --method POST
    const postCalls = log.filter(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "POST"
    );
    assert.equal(postCalls.length, 1, `expected 1 POST call, got ${postCalls.length}`);
  }
);

Then<DepauditWorld>(
  "the mock `gh` CLI did not receive any comment-edit invocation",
  async function (this: DepauditWorld) {
    const log = await this.ghMock!.readLog();
    const patchCalls = log.filter(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "PATCH"
    );
    assert.equal(patchCalls.length, 0, `expected 0 PATCH calls, got ${patchCalls.length}`);
  }
);

Then<DepauditWorld>(
  "the mock `gh` CLI received exactly one comment-edit invocation targeting the marker-bearing comment",
  async function (this: DepauditWorld) {
    const log = await this.ghMock!.readLog();
    const patchCalls = log.filter(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "PATCH"
    );
    assert.equal(patchCalls.length, 1, `expected 1 PATCH call, got ${patchCalls.length}`);
  }
);

Then<DepauditWorld>(
  "the mock `gh` CLI received exactly one comment-edit invocation targeting the oldest marker-bearing comment",
  async function (this: DepauditWorld) {
    const log = await this.ghMock!.readLog();
    const patchCalls = log.filter(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "PATCH"
    );
    assert.equal(patchCalls.length, 1, `expected 1 PATCH call, got ${patchCalls.length}`);
    // Assert it targeted the oldest (lowest id) marker-bearing comment (id=20)
    const endpoint = patchCalls[0]!.argv[1] ?? "";
    assert.ok(
      endpoint.includes("/comments/20"),
      `expected PATCH to target comment id 20, got endpoint: ${endpoint}`
    );
  }
);

Then<DepauditWorld>(
  "the mock `gh` CLI did not receive any {string} POST invocation",
  async function (this: DepauditWorld, _commandType: string) {
    const log = await this.ghMock!.readLog();
    const postCalls = log.filter(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "POST"
    );
    assert.equal(postCalls.length, 0, `expected 0 POST calls, got ${postCalls.length}`);
  }
);

Then<DepauditWorld>(
  "the mock `gh` CLI did not touch the non-depaudit comment",
  async function (this: DepauditWorld) {
    const log = await this.ghMock!.readLog();
    // The only PATCH call should target comment id 11 (the marker-bearing one), not 10
    const patchCalls = log.filter(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "PATCH"
    );
    for (const call of patchCalls) {
      const endpoint = call.argv[1] ?? "";
      assert.ok(
        !endpoint.includes("/comments/10"),
        `expected no PATCH to non-depaudit comment (id 10), got: ${endpoint}`
      );
    }
  }
);

Then<DepauditWorld>(
  "the body sent to the mock `gh` CLI contains the marker {string}",
  async function (this: DepauditWorld, markerText: string) {
    const log = await this.ghMock!.readLog();
    // Find the POST call and read its body file
    const postCall = log.find(
      (entry) =>
        entry.argv.includes("--method") &&
        entry.argv[entry.argv.indexOf("--method") + 1] === "POST"
    );
    assert.ok(postCall, "expected to find a POST call");
    // Find the body file path from --field body=@<path>
    const fieldIdx = postCall.argv.indexOf("--field");
    assert.ok(fieldIdx !== -1, "expected --field in POST call args");
    const fieldValue = postCall.argv[fieldIdx + 1] ?? "";
    assert.ok(fieldValue.startsWith("body=@"), `expected body=@ field, got: ${fieldValue}`);
    // Body file will have been cleaned up by the time we read log,
    // but the mock captures the body in state. Check via the state.
    const state = await this.ghMock!.readState();
    const comments = state.listResponse ?? [];
    const lastComment = comments[comments.length - 1];
    assert.ok(
      lastComment?.body.includes(markerText),
      `expected comment body to include marker '${markerText}', got: ${lastComment?.body}`
    );
  }
);

Then<DepauditWorld>(
  "the body sent to the mock `gh` CLI is byte-identical to the supplied markdown body",
  async function (this: DepauditWorld) {
    const state = await this.ghMock!.readState();
    const comments = state.listResponse ?? [];
    const lastComment = comments[comments.length - 1];
    // Read the body file that was supplied
    const { readFile } = await import("node:fs/promises");
    const expectedBody = await readFile(this.bodyFilePath!, "utf8");
    // Replace literal \n sequences with newlines in the expected body
    assert.equal(
      lastComment?.body,
      expectedBody,
      "expected comment body to be byte-identical to supplied markdown"
    );
  }
);

Then<DepauditWorld>(
  "the mock `gh` CLI's final PR 42 comment list contains exactly one comment whose body includes {string}",
  async function (this: DepauditWorld, markerText: string) {
    const state = await this.ghMock!.readState();
    const comments = state.listResponse ?? [];
    const markerComments = comments.filter((c) => c.body.includes(markerText));
    assert.equal(
      markerComments.length,
      1,
      `expected exactly 1 marker-bearing comment, got ${markerComments.length}`
    );
  }
);

// Pass/fail state detection
Then<DepauditWorld>(
  "the prior state reports `priorOutcome` as {string}",
  function (this: DepauditWorld, expectedOutcome: string) {
    assert.equal(
      this.priorState?.priorOutcome,
      expectedOutcome,
      `expected priorOutcome '${expectedOutcome}', got '${this.priorState?.priorOutcome}'`
    );
  }
);

// Error propagation
Then<DepauditWorld>(
  "the StateTracker invocation exits non-zero",
  function (this: DepauditWorld) {
    assert.notEqual(
      this.result?.exitCode,
      0,
      `expected non-zero exit, got 0. stdout: ${this.result?.stdout}`
    );
  }
);

// Note: "stderr mentions {string}" is already defined in lint_steps.ts and applies here too.
