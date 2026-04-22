import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "../../../templates/depaudit-gate.yml");

let raw: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wf: any;

beforeAll(async () => {
  raw = await readFile(TEMPLATE_PATH, "utf8");
  wf = parse(raw);
});

describe("templates/depaudit-gate.yml", () => {
  it("parses as valid YAML with no errors", () => {
    expect(() => parse(raw)).not.toThrow();
  });

  it("has top-level keys: name, on, permissions, jobs", () => {
    expect(wf).toHaveProperty("name");
    expect(wf).toHaveProperty("on");
    expect(wf).toHaveProperty("permissions");
    expect(wf).toHaveProperty("jobs");
  });

  it("triggers on pull_request with expected types", () => {
    const types = wf.on?.pull_request?.types;
    expect(types).toContain("opened");
    expect(types).toContain("synchronize");
    expect(types).toContain("reopened");
  });

  it("grants pull-requests: write permission", () => {
    expect(wf.permissions?.["pull-requests"]).toBe("write");
  });

  it("grants contents: read permission", () => {
    expect(wf.permissions?.["contents"]).toBe("read");
  });

  it("runs on ubuntu-latest", () => {
    expect(wf.jobs?.gate?.["runs-on"]).toBe("ubuntu-latest");
  });

  it("has a step using actions/checkout", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasCheckout = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout")
    );
    expect(hasCheckout).toBe(true);
  });

  it("has a step using actions/setup-node", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasSetupNode = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => typeof s.uses === "string" && s.uses.startsWith("actions/setup-node")
    );
    expect(hasSetupNode).toBe(true);
  });

  it("has a step that runs npm install -g depaudit", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasInstall = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => typeof s.run === "string" && s.run.includes("npm install -g depaudit")
    );
    expect(hasInstall).toBe(true);
  });

  it("has a step that runs depaudit scan and redirects to depaudit-comment.md", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasScan = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) =>
        typeof s.run === "string" &&
        s.run.includes("depaudit scan") &&
        s.run.includes("depaudit-comment.md")
    );
    expect(hasScan).toBe(true);
  });

  it("has a post-pr-comment step with if: always() condition", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasPostStep = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) =>
        typeof s.run === "string" &&
        s.run.includes("depaudit post-pr-comment") &&
        s.run.includes("depaudit-comment.md") &&
        typeof s.if === "string" &&
        s.if.includes("always()")
    );
    expect(hasPostStep).toBe(true);
  });

  it("has a final step with if: always() that propagates exit code", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasPropagateStep = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) =>
        typeof s.run === "string" &&
        s.run.includes("exit") &&
        s.run.includes("steps.scan.outputs.exit_code") &&
        s.if === "always()"
    );
    expect(hasPropagateStep).toBe(true);
  });

  it("does not contain SARIF upload steps", () => {
    const steps = wf.jobs?.gate?.steps ?? [];
    const hasSarif = steps.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) =>
        typeof s.uses === "string" &&
        (s.uses.includes("codeql-action/upload-sarif") ||
          s.uses.includes("actions/upload-sarif"))
    );
    expect(hasSarif).toBe(false);
  });

  it("does not grant security-events: write permission", () => {
    expect(wf.permissions?.["security-events"]).toBeUndefined();
  });

  it("pull_request trigger does not restrict to a single hard-coded branch", () => {
    const branches = wf.on?.pull_request?.branches;
    if (branches !== undefined) {
      expect(Array.isArray(branches) && branches.length > 1).toBe(true);
    }
  });
});
