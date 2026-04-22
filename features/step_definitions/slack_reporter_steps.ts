import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT, CLI_PATH } from "../support/world.js";
import { startMockGhBinary } from "../support/mockGhBinary.js";
import { startMockSlackServer } from "../support/mockSlackServer.js";

const execFileAsync = promisify(execFile);

const MARKER = "<!-- depaudit-gate-comment -->";
const DEFAULT_REPO = "paysdoc/depaudit-fixture";

// ─── Lifecycle ────────────────────────────────────────────────────────────────

Before<DepauditWorld>({ tags: "@adw-11" }, function (this: DepauditWorld) {
  this.savedSlackUrl = process.env["SLACK_WEBHOOK_URL"];
  this.slackMock = undefined;
  this.ghMock = undefined;
  this.bodyFilePath = undefined;
  this.transition = undefined;
});

After<DepauditWorld>({ tags: "@adw-11" }, async function (this: DepauditWorld) {
  await this.slackMock?.stop();
  await this.ghMock?.stop();
  if (this.bodyFilePath) {
    try {
      await rm(this.bodyFilePath);
    } catch {
      // best-effort
    }
  }
  if (this.savedSlackUrl === undefined) {
    delete process.env["SLACK_WEBHOOK_URL"];
  } else {
    process.env["SLACK_WEBHOOK_URL"] = this.savedSlackUrl;
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function runPostPrCommentWithSlack(world: DepauditWorld): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (world.ghMock) {
    env["PATH"] = `${world.ghMock.binDir}:${env["PATH"] ?? ""}`;
  }
  env["GITHUB_REPOSITORY"] = DEFAULT_REPO;
  env["GH_TOKEN"] = "mock-token";
  // Use a short timeout so "never responds" scenarios finish quickly
  env["SLACK_REQUEST_TIMEOUT_MS"] = "300";

  const eventDir = await mkdtemp(join(tmpdir(), "depaudit-event-"));
  const eventFile = join(eventDir, "event.json");
  await writeFile(eventFile, JSON.stringify({ pull_request: { number: 42 } }), "utf8");
  env["GITHUB_EVENT_PATH"] = eventFile;

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileAsync(
      "node",
      [CLI_PATH, "post-pr-comment", `--body-file=${world.bodyFilePath}`],
      { env }
    );
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    exitCode = typeof e.code === "number" ? e.code : 1;
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
  } finally {
    try {
      await rm(eventDir, { recursive: true });
    } catch {
      // best-effort
    }
  }
  world.result = { exitCode, stdout, stderr };
}

// ─── Background steps ─────────────────────────────────────────────────────────
// "the `depaudit` CLI is installed and on PATH" is defined in scan_steps.ts
// "a mock `gh` CLI is on PATH ..." is defined in state_tracker_steps.ts

Given<DepauditWorld>(
  "a mock Slack Incoming Webhook server that records incoming HTTP requests",
  async function (this: DepauditWorld) {
    this.slackMock = await startMockSlackServer({ status: 200, body: "ok" });
  }
);

// ─── SLACK_WEBHOOK_URL env-var setup ─────────────────────────────────────────

Given<DepauditWorld>(
  "the SLACK_WEBHOOK_URL environment variable is unset",
  function () {
    delete process.env["SLACK_WEBHOOK_URL"];
  }
);

Given<DepauditWorld>(
  "SLACK_WEBHOOK_URL is set to the empty string",
  function () {
    process.env["SLACK_WEBHOOK_URL"] = "";
  }
);

Given<DepauditWorld>(
  "SLACK_WEBHOOK_URL is set to the mock Slack webhook URL",
  function (this: DepauditWorld) {
    process.env["SLACK_WEBHOOK_URL"] = this.slackMock!.url;
  }
);

Given<DepauditWorld>(
  "SLACK_WEBHOOK_URL is set to a mock Slack webhook that responds with 503 on every request",
  async function (this: DepauditWorld) {
    await this.slackMock?.stop();
    this.slackMock = await startMockSlackServer({ status: 503, body: "down" });
    process.env["SLACK_WEBHOOK_URL"] = this.slackMock.url;
  }
);

Given<DepauditWorld>(
  "SLACK_WEBHOOK_URL is set to a mock Slack webhook that never responds",
  async function (this: DepauditWorld) {
    await this.slackMock?.stop();
    this.slackMock = await startMockSlackServer({
      transientKind: "timeout",
      failuresBeforeSuccess: Number.MAX_SAFE_INTEGER,
    });
    process.env["SLACK_WEBHOOK_URL"] = this.slackMock.url;
  }
);

// ─── Body-file setup ──────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "a markdown body representing a {word} outcome is supplied as input",
  async function (this: DepauditWorld, outcome: string) {
    const tempDir = await mkdtemp(join(tmpdir(), "depaudit-body-"));
    this.bodyFilePath = join(tempDir, "body.md");
    const header = outcome.toUpperCase() === "PASS" ? "PASS" : "FAIL";
    await writeFile(
      this.bodyFilePath,
      `${MARKER}\n## depaudit gate: ${header}\n- new: ${header === "FAIL" ? 1 : 0}\n`,
      "utf8"
    );
  }
);

// ─── When steps ───────────────────────────────────────────────────────────────

When<DepauditWorld>(
  "depaudit reconciles the PR comment and notifies Slack for PR 42",
  async function (this: DepauditWorld) {
    await runPostPrCommentWithSlack(this);
  }
);

When<DepauditWorld>(
  "depaudit reconciles the PR comment and notifies Slack for PR 42 with a {word} body",
  async function (this: DepauditWorld, outcome: string) {
    const header = outcome.toUpperCase() === "PASS" ? "PASS" : "FAIL";
    if (!this.bodyFilePath) {
      const tempDir = await mkdtemp(join(tmpdir(), "depaudit-body-"));
      this.bodyFilePath = join(tempDir, "body.md");
    }
    await writeFile(
      this.bodyFilePath,
      `${MARKER}\n## depaudit gate: ${header}\n- new: ${header === "FAIL" ? 1 : 0}\n`,
      "utf8"
    );
    await runPostPrCommentWithSlack(this);
  }
);

// ─── Then steps ───────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the mock Slack webhook received {int} requests",
  function (this: DepauditWorld, n: number) {
    assert.equal(this.slackMock?.hitCount(), n);
  }
);

Then<DepauditWorld>(
  "the mock Slack webhook received exactly {int} request",
  function (this: DepauditWorld, n: number) {
    assert.equal(this.slackMock?.hitCount(), n);
  }
);

Then<DepauditWorld>(
  "the mock Slack webhook received exactly {int} requests",
  function (this: DepauditWorld, n: number) {
    assert.equal(this.slackMock?.hitCount(), n);
  }
);

Then<DepauditWorld>(
  "the depaudit invocation exits zero",
  function (this: DepauditWorld) {
    assert.equal(this.result?.exitCode, 0, `expected exit code 0, got ${this.result?.exitCode}\nstdout: ${this.result?.stdout}\nstderr: ${this.result?.stderr}`);
  }
);

Then<DepauditWorld>(
  "the last Slack request body parses as JSON",
  function (this: DepauditWorld) {
    const reqs = this.slackMock!.requests();
    const last = reqs[reqs.length - 1]!;
    assert.doesNotThrow(
      () => JSON.parse(last.body),
      `expected last Slack request body to be valid JSON, got: ${last.body}`
    );
  }
);

Then<DepauditWorld>(
  "the last Slack request JSON has a top-level string field `{word}`",
  function (this: DepauditWorld, fieldName: string) {
    const reqs = this.slackMock!.requests();
    const last = reqs[reqs.length - 1]!;
    const parsed = JSON.parse(last.body) as Record<string, unknown>;
    assert.equal(
      typeof parsed[fieldName],
      "string",
      `expected field '${fieldName}' to be a string, got ${typeof parsed[fieldName]}`
    );
  }
);

Then<DepauditWorld>(
  "the last Slack request `{word}` field contains {string}",
  function (this: DepauditWorld, fieldName: string, expected: string) {
    const reqs = this.slackMock!.requests();
    const last = reqs[reqs.length - 1]!;
    const parsed = JSON.parse(last.body) as Record<string, string>;
    assert.ok(
      parsed[fieldName]?.includes(expected),
      `expected field '${fieldName}' to contain '${expected}', got '${parsed[fieldName]}'`
    );
  }
);

Then<DepauditWorld>(
  "the last Slack request `{word}` field contains a GitHub PR URL ending in {string}",
  function (this: DepauditWorld, fieldName: string, suffix: string) {
    const reqs = this.slackMock!.requests();
    const last = reqs[reqs.length - 1]!;
    const parsed = JSON.parse(last.body) as Record<string, string>;
    const text = parsed[fieldName] ?? "";
    const urlMatch = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    assert.ok(urlMatch, `expected a github.com PR URL in '${text}'`);
    assert.ok(
      urlMatch[0].endsWith(suffix),
      `expected URL to end with '${suffix}', got '${urlMatch[0]}'`
    );
  }
);

Then<DepauditWorld>(
  "the last Slack request used HTTP method {string}",
  function (this: DepauditWorld, method: string) {
    const reqs = this.slackMock!.requests();
    const last = reqs[reqs.length - 1]!;
    assert.equal(last.method, method);
  }
);

Then<DepauditWorld>(
  "the last Slack request Content-Type starts with {string}",
  function (this: DepauditWorld, prefix: string) {
    const reqs = this.slackMock!.requests();
    const last = reqs[reqs.length - 1]!;
    const ct = last.headers["content-type"] ?? "";
    assert.ok(
      ct.startsWith(prefix),
      `expected Content-Type to start with '${prefix}', got '${ct}'`
    );
  }
);

// Re-export PROJECT_ROOT so the import in Before hook can access it
export { PROJECT_ROOT };
