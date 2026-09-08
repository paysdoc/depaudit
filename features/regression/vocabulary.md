# Regression Vocabulary Registry

## Rot-Detection Rubric

A vocabulary phrase is valid for `@regression` use **only when it asserts an observable system
behaviour** — not a source-code property. Concretely, a phrase MUST NOT reference:

- File shape (does a file exist? how many lines? what extension?)
- File content via substring match (`readFileSync(...).includes(...)`)
- Structural source-file assertions (`JSON.parse(readFileSync(config.ts))`)

A phrase **may** reference the *outputs* of a system under test (state files written by an
orchestrator, recorded calls on a mock server, git artifacts produced by a phase) because those are
**artefacts**, not source files. This distinction is documented per phrase below.

## Observability Surfaces (Examples)

Scenarios in this repo can assert against the following observable surfaces:

| # | Surface | Evidence | Example |
|---|---------|----------|---------|
| 1 | State files | JSON or other structured output files written by orchestrators, CLI tools, or test fixtures | `agents/<adwId>/state.json` |
| 2 | Recorded HTTP requests | Request logs captured by a mock HTTP server fronting the system under test | mock server `getRecordedRequests()` |
| 3 | Git artefacts | Branches, commits, pushes, and worktree state produced by the system under test | `git log --oneline` on the worktree branch |
| 4 | Exit codes | Termination status of subprocesses spawned by the test harness | `spawnSync(...).status` |
| 5 | Log streams | stdout/stderr captured from spawned processes and asserted against by substring or regex | `spawnSync(...).stdout` |

## Three Permitted Execution Patterns

1. **Subprocess** — spawn a CLI entry-point, assert against state files, recorded mock calls, or git artefacts written by the process.
2. **Function/module import** — import a phase function directly, call it with a mocked config, assert against state mutations or mock server recordings.
3. **Mock query** — call the mock server or git-mock recording API directly; assert against the sequence of recorded requests without running a subprocess.

## Given — Subprocess / Mock Setup

| # | Phrase | Semantics |
|---|--------|-----------|
| G1 | `a subprocess fixture is loaded for {string}` | Configures the CLI stub to replay a named fixture file before spawning the subprocess under test |
| G2 | `the mock server is configured to accept {string} requests` | Seeds mock-server state so the named HTTP method + path returns a 2xx response |

## When — Invocation

| # | Phrase | Semantics |
|---|--------|-----------|
| W1 | `the {string} subprocess is invoked with args {string}` | Spawns the named CLI entry-point with the given argument string and captures its exit code |

## Then — State / Mock / Exit Assertions

| # | Phrase | Semantics |
|---|--------|-----------|
| T1 | `the subprocess exits {int}` | Asserts the captured exit code equals the expected value |
| T2 | `the mock server recorded a {string} request to {string}` | Queries mock-server recordings and asserts at least one request with the given method and path was captured |
