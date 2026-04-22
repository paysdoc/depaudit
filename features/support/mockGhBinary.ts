import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod } from "node:fs/promises";

export interface MockGhState {
  listResponse?: Array<{ id: number; body: string; user?: { login: string } }>;
  createResponse?: { id: number };
  listExitOverride?: number;
  listErrorMessage?: string;
  createExitOverride?: number;
  createErrorMessage?: string;
  exitOverride?: number;
  // @adw-12: setup command fields
  branchesMain?: { exists: boolean; body?: object };
  defaultBranch?: string;
  prCreateUrl?: string;
  prCreateExitOverride?: number;
  prCreateErrorMessage?: string;
  remoteBranches?: string[];
}

export interface MockGhHandle {
  binDir: string;
  logFile: string;
  stateFile: string;
  readLog(): Promise<Array<{ ts: number; argv: string[] }>>;
  setState(state: MockGhState): Promise<void>;
  readState(): Promise<MockGhState>;
  stop(): Promise<void>;
}

// CJS script written to the temp directory and invoked as the `gh` binary.
// Uses require() so it runs correctly in a temp dir without a package.json.
function buildGhScript(logFile: string, stateFile: string): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const LOG_FILE = ${JSON.stringify(logFile)};
const STATE_FILE = ${JSON.stringify(stateFile)};

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
  listResponse = [],
  createResponse = { id: 100 },
  listExitOverride,
  listErrorMessage,
  createExitOverride,
  createErrorMessage,
  exitOverride,
  branchesMain,
  defaultBranch,
  prCreateUrl,
  prCreateExitOverride,
  prCreateErrorMessage,
  remoteBranches,
} = state;

// Global exit override — applied before endpoint-specific handlers so it
// truly fails ALL gh invocations (e.g. for authentication-failure scenarios).
if (typeof exitOverride === 'number') {
  process.exit(exitOverride);
}

const endpoint = args[1] || '';
const methodIdx = args.indexOf('--method');
const method = methodIdx !== -1 ? args[methodIdx + 1] : 'GET';
const isPost = method === 'POST';
const isPatch = method === 'PATCH';

const isListComments = !isPost && !isPatch && /\\/issues\\/\\d+\\/comments($|\\?|\\s)/.test(endpoint + ' ');
const isCreateComment = isPost && /\\/issues\\/\\d+\\/comments$/.test(endpoint);
const isUpdateComment = isPatch && /\\/issues\\/comments\\/\\d+$/.test(endpoint);

function readBodyFromArgs(argList) {
  for (let i = 0; i < argList.length; i++) {
    if (argList[i] === '--field') {
      const next = argList[i + 1] || '';
      if (next.startsWith('body=@')) {
        const filePath = next.slice(6);
        try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
      }
    }
  }
  return null;
}

if (isListComments) {
  if (typeof listExitOverride === 'number' && listExitOverride !== 0) {
    if (listErrorMessage) process.stderr.write(listErrorMessage + '\\n');
    process.exit(listExitOverride);
  }
  process.stdout.write(JSON.stringify(listResponse) + '\\n');
  process.exit(0);
}

if (isCreateComment) {
  if (typeof createExitOverride === 'number' && createExitOverride !== 0) {
    if (createErrorMessage) process.stderr.write(createErrorMessage + '\\n');
    process.exit(createExitOverride);
  }
  const body = readBodyFromArgs(args) || '';
  const newId = createResponse.id;
  const newComment = { id: newId, body, user: { login: 'github-actions[bot]' } };
  const newState = Object.assign({}, state, {
    listResponse: listResponse.concat([newComment]),
    createResponse: { id: newId + 1 },
  });
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(newState)); } catch {}
  process.stdout.write(JSON.stringify({ id: newId }) + '\\n');
  process.exit(0);
}

if (isUpdateComment) {
  const body = readBodyFromArgs(args) || '';
  const idMatch = endpoint.match(/\\/comments\\/(\\d+)$/);
  if (idMatch) {
    const commentId = parseInt(idMatch[1], 10);
    const updatedList = listResponse.map(function(c) {
      return c.id === commentId ? Object.assign({}, c, { body: body }) : c;
    });
    const newState = Object.assign({}, state, { listResponse: updatedList });
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(newState)); } catch {}
  }
  process.stdout.write('{}\\n');
  process.exit(0);
}

// @adw-12: gh api repos/.../branches/main
if (args[0] === 'api' && /\\/branches\\/main$/.test(endpoint)) {
  const bm = branchesMain !== undefined ? branchesMain : { exists: true };
  const exists = Array.isArray(remoteBranches)
    ? remoteBranches.includes('main')
    : (bm.exists !== false);
  if (exists) {
    process.stdout.write(JSON.stringify(bm.body || { name: 'main' }) + '\\n');
    process.exit(0);
  } else {
    process.stderr.write('HTTP 404: Not Found\\n');
    process.exit(1);
  }
}

// @adw-12: gh api repos/... --jq .default_branch
if (args[0] === 'api' && args.includes('--jq') && args.includes('.default_branch')) {
  const branch = defaultBranch || (Array.isArray(remoteBranches) && remoteBranches.length > 0 ? remoteBranches[0] : 'main');
  process.stdout.write(branch + '\\n');
  process.exit(0);
}

// @adw-12: gh pr create
if (args[0] === 'pr' && args[1] === 'create') {
  if (typeof prCreateExitOverride === 'number' && prCreateExitOverride !== 0) {
    if (prCreateErrorMessage) process.stderr.write(prCreateErrorMessage + '\\n');
    process.exit(prCreateExitOverride);
  }
  process.stdout.write((prCreateUrl || 'https://github.com/owner/repo/pull/1') + '\\n');
  process.exit(0);
}

// @adw-12: gh secret set — assert NOT called
if (args[0] === 'secret' && args[1] === 'set') {
  // Allow but log — tests assert this was not called
  process.exit(0);
}

process.exit(0);
`;
}

export async function startMockGhBinary(
  initial: MockGhState = {}
): Promise<MockGhHandle> {
  const tempDir = await mkdtemp(join(tmpdir(), "depaudit-mock-gh-"));
  const binDir = tempDir;
  const logFile = join(tempDir, "calls.log");
  const stateFile = join(tempDir, "state.json");

  const defaultState: MockGhState = {
    listResponse: [],
    createResponse: { id: 100 },
    ...initial,
  };

  await writeFile(stateFile, JSON.stringify(defaultState), "utf8");
  await writeFile(logFile, "", "utf8");

  const scriptPath = join(binDir, "gh");
  await writeFile(scriptPath, buildGhScript(logFile, stateFile), "utf8");
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
    async setState(state: MockGhState) {
      await writeFile(stateFile, JSON.stringify(state), "utf8");
    },
    async readState() {
      const content = await readFile(stateFile, "utf8");
      return JSON.parse(content) as MockGhState;
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
