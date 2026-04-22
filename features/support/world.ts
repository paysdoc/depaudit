import { setDefaultTimeout, setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI_PATH = resolve(PROJECT_ROOT, "dist/cli.js");

// `depaudit scan` shells out to `osv-scanner`, which routinely takes 2–4s per
// invocation and can spike past Cucumber's 5s default under load.
setDefaultTimeout(30_000);

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class DepauditWorld extends World {
  result: RunResult | null = null;
  cwd: string = PROJECT_ROOT;
  /** Absolute path of the fixture currently under test */
  fixturePath: string = PROJECT_ROOT;
  /** Files written during this scenario — cleaned up by After hooks in lint_steps.ts */
  writtenFiles: string[] = [];
  /** Base URL of the mock Socket server for the current @adw-7 scenario */
  socketMockUrl?: string;
  /** Socket API token — string=set, undefined=explicitly unset from env */
  socketToken?: string;
  /** Per-request timeout override for Socket client (ms) — used to speed up BDD timeout scenarios */
  socketRequestTimeoutMs?: number;
  /** Mock server handle for teardown */
  socketMock?: { stop: () => Promise<void>; hitCount: () => number };
  /** Package name that the mock Socket server will flag (set by step definitions) */
  socketAlertPackage?: string;
  /** Package version that the mock Socket server will flag */
  socketAlertVersion?: string;
  /** Original file contents for @adw-13 restore-after-test — keyed by absolute file path */
  originalFileContents?: Map<string, string>;
  /** Captured file content for idempotency checks in @adw-13 scenarios */
  capturedFileContent?: string;
  /** Path to a temp directory containing a fake osv-scanner binary (for OSV failure scenarios) */
  fakeOsvBinDir?: string;
  /** Captured stdout snapshots keyed by label — used by @adw-9 snapshot-reproducibility scenarios */
  capturedStdout: Record<string, string> = {};
  /** Mocked gh binary handle for @adw-10 scenarios */
  ghMock?: import("./mockGhBinary.js").MockGhHandle;
  /** Body file path for post-pr-comment (@adw-10) */
  bodyFilePath?: string;
  /** Resolved prior state from readPriorState (@adw-10) */
  priorState?: import("../../src/types/prComment.js").PriorState;
  /** Mock Slack webhook server handle (@adw-11) */
  slackMock?: import("./mockSlackServer.js").MockSlackHandle;
  /** Saved SLACK_WEBHOOK_URL for restore in After hook (@adw-11) */
  savedSlackUrl?: string | undefined;
  /** Computed transition result (@adw-11 transition scenarios in state_tracker.feature) */
  transition?: import("../../src/types/prComment.js").SlackTransition;
  /** Mock git binary handle for @adw-12 scenarios */
  gitMock?: import("./mockGitBinary.js").MockGitHandle;
  /** Fixture path for @adw-12 setup scenarios */
  setupFixturePath?: string;
  /** Resolved trigger branch from @adw-12 setup scenarios */
  setupResolvedBranch?: string;
  /** Result from CommitOrPrExecutor invocation in @adw-12 BDD */
  commitOrPrResult?: { exitCode: number; stdout: string; stderr: string };

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(DepauditWorld);
