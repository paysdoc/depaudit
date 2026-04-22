import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod } from "node:fs/promises";

export interface MockGitState {
  currentBranch?: string;
  originUrl?: string;
  commitSha?: string;
  existingRemoteBranches?: string[];
  commitExitOverride?: number;
  commitErrorMessage?: string;
  pushExitOverride?: number;
  pushErrorMessage?: string;
  checkoutExitOverride?: number;
  checkoutErrorMessage?: string;
  addExitOverride?: number;
  addErrorMessage?: string;
  branchShowCurrentExitOverride?: number;
  branchShowCurrentErrorMessage?: string;
}

export interface MockGitHandle {
  binDir: string;
  logFile: string;
  stateFile: string;
  readLog(): Promise<Array<{ ts: number; argv: string[] }>>;
  setState(state: MockGitState): Promise<void>;
  readState(): Promise<MockGitState>;
  stop(): Promise<void>;
}

function buildGitScript(logFile: string, stateFile: string): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const LOG_FILE = ${JSON.stringify(logFile)};
const STATE_FILE = ${JSON.stringify(stateFile)};

// Filter out -C <path> prefix (from git -C <repoRoot> <cmd>)
let filtered = args;
if (filtered[0] === '-C') {
  filtered = filtered.slice(2);
}

// Log this invocation
try {
  const entry = JSON.stringify({ ts: Date.now(), argv: args }) + '\\n';
  fs.appendFileSync(LOG_FILE, entry);
} catch {}

// Read state
let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  state = {};
}

const {
  currentBranch = 'main',
  originUrl = 'https://github.com/owner/repo.git',
  commitSha = 'abc123sha',
  existingRemoteBranches = [],
  commitExitOverride,
  commitErrorMessage,
  pushExitOverride,
  pushErrorMessage,
  checkoutExitOverride,
  checkoutErrorMessage,
  addExitOverride,
  addErrorMessage,
  branchShowCurrentExitOverride,
  branchShowCurrentErrorMessage,
} = state;

const subcmd = filtered[0];
const subcmd2 = filtered[1];

// git branch --show-current
if (subcmd === 'branch' && filtered.includes('--show-current')) {
  if (typeof branchShowCurrentExitOverride === 'number' && branchShowCurrentExitOverride !== 0) {
    if (branchShowCurrentErrorMessage) process.stderr.write(branchShowCurrentErrorMessage + '\\n');
    process.exit(branchShowCurrentExitOverride);
  }
  process.stdout.write(currentBranch + '\\n');
  process.exit(0);
}

// git remote get-url origin
if (subcmd === 'remote' && subcmd2 === 'get-url') {
  process.stdout.write(originUrl + '\\n');
  process.exit(0);
}

// git add <paths>
if (subcmd === 'add') {
  if (typeof addExitOverride === 'number' && addExitOverride !== 0) {
    if (addErrorMessage) process.stderr.write(addErrorMessage + '\\n');
    process.exit(addExitOverride);
  }
  process.exit(0);
}

// git commit -m <msg>
if (subcmd === 'commit') {
  if (typeof commitExitOverride === 'number' && commitExitOverride !== 0) {
    if (commitErrorMessage) process.stderr.write(commitErrorMessage + '\\n');
    process.exit(commitExitOverride);
  }
  process.exit(0);
}

// git rev-parse HEAD
if (subcmd === 'rev-parse' && filtered.includes('HEAD')) {
  process.stdout.write(commitSha + '\\n');
  process.exit(0);
}

// git checkout -b <branch>
if (subcmd === 'checkout' && filtered.includes('-b')) {
  if (typeof checkoutExitOverride === 'number' && checkoutExitOverride !== 0) {
    if (checkoutErrorMessage) process.stderr.write(checkoutErrorMessage + '\\n');
    process.exit(checkoutExitOverride);
  }
  // Update current branch in state
  const newBranch = filtered[filtered.indexOf('-b') + 1];
  if (newBranch) {
    const newState = Object.assign({}, state, { currentBranch: newBranch });
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(newState)); } catch {}
  }
  process.exit(0);
}

// git push --set-upstream origin <branch>
if (subcmd === 'push') {
  if (typeof pushExitOverride === 'number' && pushExitOverride !== 0) {
    if (pushErrorMessage) process.stderr.write(pushErrorMessage + '\\n');
    process.exit(pushExitOverride);
  }
  process.exit(0);
}

// git ls-remote --exit-code origin <branch>
if (subcmd === 'ls-remote' && filtered.includes('--exit-code')) {
  const branchArg = filtered[filtered.length - 1];
  const branches = Array.isArray(existingRemoteBranches) ? existingRemoteBranches : [];
  if (branches.includes(branchArg)) {
    process.stdout.write('abc123\\trefs/heads/' + branchArg + '\\n');
    process.exit(0);
  } else {
    process.exit(2);
  }
}

// Default: succeed silently
process.exit(0);
`;
}

export async function startMockGitBinary(
  initial: MockGitState = {}
): Promise<MockGitHandle> {
  const tempDir = await mkdtemp(join(tmpdir(), "depaudit-mock-git-"));
  const binDir = tempDir;
  const logFile = join(tempDir, "calls.log");
  const stateFile = join(tempDir, "state.json");

  const defaultState: MockGitState = {
    currentBranch: "main",
    originUrl: "https://github.com/owner/repo.git",
    commitSha: "abc123sha",
    existingRemoteBranches: [],
    ...initial,
  };

  await writeFile(stateFile, JSON.stringify(defaultState), "utf8");
  await writeFile(logFile, "", "utf8");

  const scriptPath = join(binDir, "git");
  await writeFile(scriptPath, buildGitScript(logFile, stateFile), "utf8");
  await chmod(scriptPath, 0o755);

  return {
    binDir,
    logFile,
    stateFile,
    async readLog() {
      const content = await readFile(logFile, "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { ts: number; argv: string[] });
    },
    async setState(state: MockGitState) {
      await writeFile(stateFile, JSON.stringify(state), "utf8");
    },
    async readState() {
      const content = await readFile(stateFile, "utf8");
      return JSON.parse(content) as MockGitState;
    },
    async stop() {
      try {
        await rm(tempDir, { recursive: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
