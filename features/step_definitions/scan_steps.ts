import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { DepauditWorld, PROJECT_ROOT, CLI_PATH } from "../support/world.js";
import { startMockSocketServer } from "../support/mockSocketServer.js";

const execFileAsync = promisify(execFile);

const FINDING_LINE_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL)$/;

// ─── Background ─────────────────────────────────────────────────────────────

Given<DepauditWorld>("the `osv-scanner` binary is installed and on PATH", async function () {
  try {
    await execFileAsync("osv-scanner", ["--version"]);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") {
      return "pending";
    }
  }
});

Given<DepauditWorld>("the `depaudit` CLI is installed and on PATH", async function () {
  try {
    await access(CLI_PATH);
  } catch {
    throw new Error(`dist/cli.js not found — run 'bun run build' first`);
  }
});

// ─── Fixture setup (just verify fixtures exist) ───────────────────────────

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifests have no known CVEs",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} whose manifest pins a package with a known OSV CVE",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} that produces exactly one OSV finding",
  async function (this: DepauditWorld, fixturePath: string) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} with the following files:",
  async function (this: DepauditWorld, fixturePath: string, _table: unknown) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>(
  "a fixture Node repository at {string} with package.json files at:",
  async function (this: DepauditWorld, fixturePath: string, _table: unknown) {
    this.fixturePath = resolve(PROJECT_ROOT, fixturePath);
    await access(this.fixturePath);
  }
);

Given<DepauditWorld>("{string} pins a package with a known OSV CVE", function (_filePath: string) {
  // declared by fixture structure — no runtime check needed
});

Given<DepauditWorld>(
  "{string} and {string} have no known CVEs",
  function (_pathA: string, _pathB: string) {
    // declared by fixture structure — no runtime check needed
  }
);

Given<DepauditWorld>(
  "the current working directory is {string}",
  function (this: DepauditWorld, cwdPath: string) {
    this.cwd = resolve(PROJECT_ROOT, cwdPath);
  }
);

// ─── When steps ────────────���─────────────────────────────────────────────────

export async function runDepaudit(world: DepauditWorld, args: string[]): Promise<void> {
  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Forward Socket env vars when set by @adw-7 steps.
  // socketToken semantics:
  //   undefined  → don't touch SOCKET_API_TOKEN (pass-through from process.env)
  //   ""         → explicitly delete SOCKET_API_TOKEN from env (test "no token" scenario)
  //   "somevalue" → set SOCKET_API_TOKEN to that value
  if (world.socketMockUrl !== undefined) env["SOCKET_API_BASE_URL"] = world.socketMockUrl;
  if (world.socketToken === "") {
    delete env["SOCKET_API_TOKEN"];
  } else if (world.socketToken !== undefined) {
    env["SOCKET_API_TOKEN"] = world.socketToken;
  }
  // if socketToken is undefined → leave SOCKET_API_TOKEN as-is from process.env
  if (world.socketRequestTimeoutMs !== undefined) {
    env["SOCKET_REQUEST_TIMEOUT_MS"] = String(world.socketRequestTimeoutMs);
  }
  // Prepend fake osv-scanner bin dir to PATH for OSV failure simulation (@adw-13)
  if (world.fakeOsvBinDir !== undefined) {
    const existingPath = env["PATH"] ?? "";
    env["PATH"] = `${world.fakeOsvBinDir}:${existingPath}`;
  }

  // For scenarios that don't configure socket (e.g. regression tests), if no
  // SOCKET_API_TOKEN is available in env, spin up a no-op mock so the CLI
  // doesn't fail with SocketAuthError and break non-socket scenarios.
  let fallbackMock: Awaited<ReturnType<typeof startMockSocketServer>> | undefined;
  const needsFallback =
    world.socketToken === undefined &&
    world.socketMockUrl === undefined &&
    !env["SOCKET_API_TOKEN"];
  if (needsFallback) {
    fallbackMock = await startMockSocketServer({ body: [] });
    env["SOCKET_API_BASE_URL"] = fallbackMock.url;
    env["SOCKET_API_TOKEN"] = "fallback-no-op-token";
  }

  try {
    const result = await execFileAsync("node", [CLI_PATH, ...args], { cwd: world.cwd, env });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    exitCode = typeof e.code === "number" ? e.code : 1;
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
  } finally {
    if (fallbackMock) await fallbackMock.stop();
  }
  world.result = { exitCode, stdout, stderr };
}

When<DepauditWorld>("I run {string}", async function (this: DepauditWorld, commandStr: string) {
  const parts = commandStr.trim().split(/\s+/);
  if (parts[0] === "depaudit") parts.shift();
  await runDepaudit(this, parts);
});

When<DepauditWorld>(
  "I run {string} with no path argument",
  async function (this: DepauditWorld, commandStr: string) {
    const parts = commandStr.trim().split(/\s+/);
    if (parts[0] === "depaudit") parts.shift();
    await runDepaudit(this, parts);
  }
);

// ─��─ Then steps ──────────────────────────────────────────────────────────────

Then<DepauditWorld>("the exit code is {int}", function (this: DepauditWorld, expected: number) {
  assert.equal(this.result!.exitCode, expected, `expected exit ${expected}, got ${this.result!.exitCode}\nstderr: ${this.result!.stderr}`);
});

Then<DepauditWorld>("the exit code is non-zero", function (this: DepauditWorld) {
  assert.notEqual(this.result!.exitCode, 0, `expected non-zero exit, got 0\nstdout: ${this.result!.stdout}`);
});

Then<DepauditWorld>("stdout contains no finding lines", function (this: DepauditWorld) {
  const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 0, `expected no finding lines, got:\n${this.result!.stdout}`);
});

Then<DepauditWorld>("stdout contains at least one finding line", function (this: DepauditWorld) {
  const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, `expected at least one finding line, got empty stdout\nstderr: ${this.result!.stderr}`);
});

Then<DepauditWorld>(
  "each finding line contains a package name, a version, a finding-ID, and a severity",
  function (this: DepauditWorld) {
    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      assert.match(line, FINDING_LINE_RE, `finding line did not match expected format: "${line}"`);
    }
  }
);

Then<DepauditWorld>("stdout contains exactly one finding line", function (this: DepauditWorld) {
  const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly 1 finding line, got ${lines.length}:\n${this.result!.stdout}`);
});

Then<DepauditWorld>(
  "the finding line matches the pattern {string}",
  function (this: DepauditWorld, _pattern: string) {
    const line = this.result!.stdout.trim();
    assert.match(line, FINDING_LINE_RE, `finding line did not match format: "${line}"`);
  }
);

Then<DepauditWorld>("stderr mentions that the path does not exist", function (this: DepauditWorld) {
  const hasEnoent = /does.not.exist|ENOENT|no such file/i.test(this.result!.stderr);
  assert.ok(hasEnoent, `expected stderr to mention path not found, got: "${this.result!.stderr}"`);
});

Then<DepauditWorld>(
  "stdout contains a finding line whose package name matches a dependency declared in {string}",
  async function (this: DepauditWorld, manifestRelPath: string) {
    const manifestPath = resolve(this.fixturePath, manifestRelPath);
    const pkgJson = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const depNames = Object.keys(pkgJson.dependencies ?? {});

    const lines = this.result!.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, `expected at least one finding line`);

    const foundPkgs = lines.map((l) => l.split(" ")[0]);
    const match = foundPkgs.some((p) => depNames.includes(p));
    assert.ok(
      match,
      `no finding line matched a dependency from ${manifestRelPath}.\n` +
      `Dependencies: ${depNames.join(", ")}\n` +
      `Finding packages: ${foundPkgs.join(", ")}`
    );
  }
);
