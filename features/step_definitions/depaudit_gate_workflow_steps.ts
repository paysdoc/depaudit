import { Given, When, Then } from "@cucumber/cucumber";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { DepauditWorld, PROJECT_ROOT } from "../support/world.js";

const TEMPLATE_PATH = resolve(PROJECT_ROOT, "templates/depaudit-gate.yml");

// Store parsed workflow in world between When/Then steps
declare module "../support/world.js" {
  interface DepauditWorld {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedWorkflow?: any;
    templatePath?: string;
  }
}

// ─── Background ─────────────────────────────────────────────────────────────

Given<DepauditWorld>(
  "the packaged `depaudit-gate.yml` workflow template ships inside the depaudit package",
  function () {
    // The template is bundled at templates/depaudit-gate.yml — no runtime check needed here
  }
);

// ─── When steps ──────────────────────────────────────────────────────────────

When<DepauditWorld>(
  "I resolve the path of the packaged `depaudit-gate.yml` template",
  function (this: DepauditWorld) {
    this.templatePath = TEMPLATE_PATH;
  }
);

When<DepauditWorld>(
  "I read the packaged `depaudit-gate.yml` template",
  async function (this: DepauditWorld) {
    const raw = await readFile(TEMPLATE_PATH, "utf8");
    this.parsedWorkflow = parse(raw);
    this.templatePath = TEMPLATE_PATH;
  }
);

// ─── File existence ──────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the packaged `depaudit-gate.yml` file exists on disk",
  async function (this: DepauditWorld) {
    await access(this.templatePath ?? TEMPLATE_PATH);
  }
);

Then<DepauditWorld>(
  "the template parses as valid YAML with no errors",
  async function (this: DepauditWorld) {
    const raw = await readFile(TEMPLATE_PATH, "utf8");
    assert.doesNotThrow(() => parse(raw));
  }
);

// ─── Workflow structure ──────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the parsed workflow has a top-level `on` trigger block",
  function (this: DepauditWorld) {
    assert.ok(this.parsedWorkflow?.on, "expected top-level 'on' key");
  }
);

Then<DepauditWorld>(
  "the parsed workflow has a top-level `jobs` block with at least one job",
  function (this: DepauditWorld) {
    const jobs = this.parsedWorkflow?.jobs;
    assert.ok(jobs && Object.keys(jobs).length > 0, "expected at least one job");
  }
);

Then<DepauditWorld>(
  "the workflow's `on` trigger includes `pull_request`",
  function (this: DepauditWorld) {
    const on = this.parsedWorkflow?.on;
    assert.ok(on?.pull_request !== undefined, "expected on.pull_request to be defined");
  }
);

Then<DepauditWorld>(
  "the workflow's `permissions` block grants `pull-requests: write`",
  function (this: DepauditWorld) {
    assert.equal(
      this.parsedWorkflow?.permissions?.["pull-requests"],
      "write",
      "expected permissions.pull-requests = write"
    );
  }
);

Then<DepauditWorld>(
  "the workflow's `permissions` block grants `contents: read`",
  function (this: DepauditWorld) {
    assert.equal(
      this.parsedWorkflow?.permissions?.["contents"],
      "read",
      "expected permissions.contents = read"
    );
  }
);

Then<DepauditWorld>(
  "the depaudit-gate job's `runs-on` value starts with {string}",
  function (this: DepauditWorld, prefix: string) {
    const runsOn: string = this.parsedWorkflow?.jobs?.gate?.["runs-on"] ?? "";
    assert.ok(
      runsOn.startsWith(prefix),
      `expected runs-on to start with '${prefix}', got '${runsOn}'`
    );
  }
);

Then<DepauditWorld>(
  "the depaudit-gate job has a step that uses {string}",
  function (this: DepauditWorld, actionPrefix: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const found = steps.some(
      (s) => typeof s.uses === "string" && s.uses.startsWith(actionPrefix)
    );
    assert.ok(found, `expected a step using '${actionPrefix}'`);
  }
);

// ─── Install / scan / capture ────────────────────────────────────────────────

Then<DepauditWorld>(
  "at least one `run` step in the depaudit-gate job contains {string}",
  function (this: DepauditWorld, text: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const found = steps.some((s) => typeof s.run === "string" && s.run.includes(text));
    assert.ok(found, `expected a run step containing '${text}'`);
  }
);

Then<DepauditWorld>(
  "at least one `run` step in the depaudit-gate job redirects `depaudit scan` stdout into a file",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const found = steps.some(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("depaudit scan") &&
        s.run.includes(">")
    );
    assert.ok(found, "expected a step redirecting depaudit scan output to a file");
  }
);

// ─── Exit code propagation ───────────────────────────────────────────────────

Then<DepauditWorld>(
  "the `depaudit scan` step does not swallow its exit code",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const scanStep = steps.find(
      (s) => typeof s.run === "string" && s.run.includes("depaudit scan")
    );
    assert.ok(scanStep, "expected to find the depaudit scan step");
    // The step captures $? (exit code) — it uses set +e and captures the exit code
    assert.ok(
      scanStep.run.includes("$?"),
      "expected scan step to capture exit code via $?"
    );
  }
);

Then<DepauditWorld>(
  "the depaudit-gate job fails when `depaudit scan` exits non-zero",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    // There must be a step that exits with the captured scan exit code
    const propagateStep = steps.find(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("exit") &&
        s.run.includes("steps.scan.outputs.exit_code")
    );
    assert.ok(propagateStep, "expected a step that propagates the scan exit code");
  }
);

// ─── PR comment step ─────────────────────────────────────────────────────────

Then<DepauditWorld>(
  /^the PR-comment step runs under an `if: always\(\)` \(or equivalent\) condition$/,
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const postStep = steps.find(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("post-pr-comment")
    );
    assert.ok(postStep, "expected to find the post-pr-comment step");
    assert.ok(
      typeof postStep.if === "string" && postStep.if.includes("always()"),
      `expected post-pr-comment step to have if: always(), got: ${postStep.if}`
    );
  }
);

Then<DepauditWorld>(
  "at least one `run` step in the depaudit-gate job invokes the `gh` CLI",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    // The post-pr-comment step invokes gh indirectly (via depaudit post-pr-comment)
    // Alternatively there could be a direct gh invocation
    const found = steps.some(
      (s) =>
        typeof s.run === "string" &&
        (s.run.includes("post-pr-comment") || s.run.includes("gh "))
    );
    assert.ok(found, "expected a step that invokes gh or post-pr-comment (which uses gh)");
  }
);

Then<DepauditWorld>(
  "the PR-comment step reads the captured markdown file as the comment body source",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const postStep = steps.find(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("post-pr-comment") &&
        s.run.includes("depaudit-comment.md")
    );
    assert.ok(postStep, "expected post-pr-comment step to reference depaudit-comment.md");
  }
);

Then<DepauditWorld>(
  "the PR-comment step's environment includes a GITHUB_TOKEN secret reference",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const postStep = steps.find(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("post-pr-comment")
    );
    assert.ok(postStep, "expected to find post-pr-comment step");
    const env = postStep.env ?? {};
    const hasToken = Object.values(env).some(
      (v) => typeof v === "string" && v.includes("GITHUB_TOKEN")
    );
    assert.ok(hasToken, "expected post-pr-comment step env to include GITHUB_TOKEN reference");
  }
);

// ─── Secrets ─────────────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the `depaudit scan` step's environment includes a SOCKET_API_TOKEN secret reference",
  function (this: DepauditWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const scanStep = steps.find(
      (s) => typeof s.run === "string" && s.run.includes("depaudit scan")
    );
    assert.ok(scanStep, "expected to find scan step");
    const env = scanStep.env ?? {};
    const hasToken = Object.values(env).some(
      (v) => typeof v === "string" && v.includes("SOCKET_API_TOKEN")
    );
    assert.ok(hasToken, "expected scan step env to include SOCKET_API_TOKEN reference");
  }
);

// ─── SARIF exclusion ─────────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the workflow does not contain a step that uses {string}",
  function (this: DepauditWorld, actionName: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: any[] = this.parsedWorkflow?.jobs?.gate?.steps ?? [];
    const found = steps.some(
      (s) => typeof s.uses === "string" && s.uses.includes(actionName)
    );
    assert.ok(!found, `expected NO step using '${actionName}'`);
  }
);

Then<DepauditWorld>(
  "the workflow's `permissions` block does NOT grant `security-events: write`",
  function (this: DepauditWorld) {
    const secEvents = this.parsedWorkflow?.permissions?.["security-events"];
    assert.ok(
      secEvents === undefined || secEvents !== "write",
      "expected security-events not to be 'write'"
    );
  }
);

// ─── Branch agnosticism ───────────────────────────────────────────────────────

Then<DepauditWorld>(
  "the workflow's `on.pull_request` block does not restrict to a single hard-coded target branch",
  function (this: DepauditWorld) {
    const branches = this.parsedWorkflow?.on?.pull_request?.branches;
    if (branches !== undefined) {
      assert.ok(
        Array.isArray(branches) && branches.length !== 1,
        "expected no single hard-coded branch restriction"
      );
    }
    // No branches key = fires on all branches (correct)
  }
);
