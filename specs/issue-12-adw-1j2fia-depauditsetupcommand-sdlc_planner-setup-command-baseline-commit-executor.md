# Feature: DepauditSetupCommand + Baseline + CommitOrPrExecutor

## Metadata
issueNumber: `12`
adwId: `1j2fia-depauditsetupcommand`
issueJson: `{"number":12,"title":"DepauditSetupCommand + baseline + CommitOrPrExecutor","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\n`DepauditSetupCommand` implements `depaudit setup`. Steps per PRD \"Bootstrap\" section:\n\n1. Detect ecosystems via `ManifestDiscoverer`.\n2. Resolve trigger branch (`main` if exists on remote, else default branch) via `gh api`.\n3. Scaffold `.github/workflows/depaudit-gate.yml` pinned to the resolved branch, with Slack block included (from #9).\n4. Scaffold `osv-scanner.toml` + `.depaudit.yml` with detected ecosystems.\n5. Update `.gitignore` to exclude `.depaudit/findings.json`.\n6. Run first scan.\n7. Baseline: write every finding at or above threshold as an accepted entry with `reason: \"baselined at install\"`, `expires: today + 90d`.\n8. Commit via `CommitOrPrExecutor` — commit directly if current branch is NOT the resolved prod branch; otherwise create `depaudit-setup` branch, push, open PR.\n\nSetting secrets (`SOCKET_API_TOKEN`, `SLACK_WEBHOOK_URL`) is out of scope here — that lives in ADW's `adwInit.tsx` hook (slice 16). For non-ADW adopters, the README documents setting them manually.\n\n## Acceptance criteria\n\n- [ ] `depaudit setup` succeeds in a freshly-cloned fixture repo with no prior depaudit state.\n- [ ] Correct branch resolution (main-exists vs default-only).\n- [ ] All scaffolded files match the template; workflow file references the resolved branch.\n- [ ] Baseline entries honor the configured severity threshold; all carry the canonical reason + 90d expiry.\n- [ ] `CommitOrPrExecutor` chooses commit vs branch-and-PR per current branch.\n- [ ] Integration tests: one for the feature-branch path (direct commit), one for the prod-branch path (branch + PR).\n- [ ] Unit tests for `CommitOrPrExecutor` with mocked `git` / `gh`.\n\n## Blocked by\n\n- Blocked by #11\n\n## User stories addressed\n\n- User story 11 (partial; ADW propagation in slice 16)\n- User story 12\n- User story 13\n- User story 14\n- User story 27\n","state":"OPEN","author":"paysdoc","labels":[],"createdAt":"2026-04-17T13:24:44Z","comments":[],"actionableComment":null}`

## Feature Description

`depaudit setup` is the bootstrap command that turns an unmanaged target repository into one that runs the depaudit gate on every PR. It is the single entry point through which ADW's `adwInit.tsx` and non-ADW manual adopters wire depaudit into a repo for the first time. Until this slice lands, every previous module (manifest discoverer, config loader, finding matcher, OSV adapter, Socket client, JSON / Markdown / Slack reporters, gate workflow template, state tracker, post-pr-comment subcommand) sits on the shelf — there is no way to install it onto a fresh repo without a maintainer hand-authoring six artifacts and remembering to commit a baseline.

Concretely this slice delivers, end to end:

1. **A new CLI subcommand** — `depaudit setup [path]` — wired into `src/cli.ts`. Default path is the current working directory.

2. **Trigger branch resolution.** `main` is preferred when it exists on the remote (`gh api repos/:owner/:repo/branches/main`); when it does not, the repo's default branch (`gh api repos/:owner/:repo --jq .default_branch`) is used. The resolved name is the **Trigger branch** in the ubiquitous-language sense (`UBIQUITOUS_LANGUAGE.md:32`) and is the value substituted into the gate workflow template's "fires on PRs into" mental model. The current packaged template is branch-agnostic at the `on.pull_request` level (no `branches:` restriction) but pin information is documented inline as a generated header comment so a maintainer reading the workflow can see which branch the setup command anchored on.

3. **Polyglot ecosystem detection.** Re-uses the existing `ManifestDiscoverer` (`src/modules/manifestDiscoverer.ts`) to infer the set of ecosystems in the tree. The detected ecosystems are surfaced inside the scaffolded `.depaudit.yml` as a stable, sorted list under `policy.ecosystems` (when discovery turns up at least one ecosystem) so future scans honor an explicit allowlist rather than re-deriving on every run. When no manifests are discoverable the value remains `auto` (no narrowing).

4. **Scaffolded artifacts.**
   - `.github/workflows/depaudit-gate.yml` — copied verbatim from `templates/depaudit-gate.yml`. A header comment is prepended documenting the trigger branch and the timestamp at which `depaudit setup` resolved it. The Slack notification block (the `SLACK_WEBHOOK_URL` env entry on the `Post or update PR comment` step) is already in the packaged template from issue #11.
   - `osv-scanner.toml` — empty body with a documentation header comment. CVE acceptances will be added by `[[IgnoredVulns]]` either by the baseline below or by the `/depaudit-triage` skill later.
   - `.depaudit.yml` — populated from `DEFAULT_DEPAUDIT_CONFIG`, with `policy.ecosystems` set to the sorted detected list (or left as `auto` when no manifests were found). `commonAndFine` and `supplyChainAccepts` start empty, then are populated by the baseline step below.

5. **`.gitignore` augmentation.** A single line `.depaudit/findings.json` is appended (or, for net-new `.gitignore`, the file is created with that line). Idempotent: if the line already exists, the file is left untouched. This pre-emptively suppresses the `JsonReporter`'s "not gitignored" warning (`src/modules/jsonReporter.ts:67`) on the very next scan.

6. **First-scan baseline.** `runScanCommand(repoPath)` is invoked once in-process. Every classified finding above the configured **Severity threshold** (default `medium`) becomes an **Acceptance**:
   - `source: "osv"` findings → an `[[IgnoredVulns]]` entry in `osv-scanner.toml` with `id = <findingId>`, `ignoreUntil = <today + 90d>`, `reason = "baselined at install"`.
   - `source: "socket"` findings → a `supplyChainAccepts` entry in `.depaudit.yml` with `package`, `version`, `findingId`, `expires = <today + 90d>`, `reason = "baselined at install"`.
   - The `reason` and 90-day cap are deliberate (PRD `:278` "Baseline entries decay"). When the entries expire the maintainer is forced to make a real classification decision per finding.
   - Findings that were already classified as `accepted` or `whitelisted` by the matcher are not re-baselined (avoids duplicate entries).
   - Findings classified as `expired-accept` keep their existing entry — re-baselining a freshly-expired accept would silently extend it, defeating the whole point of expiry. The setup command surfaces `expired-accept` cases in stdout and leaves them for the maintainer to handle.

7. **Commit-or-PR decision.** A new `CommitOrPrExecutor` deep module wraps the policy: if the current local branch is the **Trigger branch**, the changes are pushed onto a new `depaudit-setup` branch and a PR is opened (via `gh pr create`); otherwise the changes are committed directly onto the current branch. The local branch is never force-pushed; if the `depaudit-setup` branch already exists on the remote a numeric suffix is appended (`depaudit-setup-2`, `depaudit-setup-3`, …) so concurrent setup runs do not collide. Author identity is taken from the local git config — the executor never mutates `git config user.email` / `user.name`.

8. **Stdout summary.** The command prints a single multi-line summary describing every artifact written, every baseline entry, the trigger branch, and the commit / PR action taken. The summary is the human-facing record of what happened; it is not consumed by downstream tooling (`/depaudit-triage` reads `.depaudit/findings.json` instead).

Setting GitHub Actions secrets (`SOCKET_API_TOKEN`, `SLACK_WEBHOOK_URL`) is intentionally **out of scope** for this slice. The PRD step `:163` is delegated to ADW's `adwInit.tsx` (slice 16), which has access to the centralised secret material in the ADW user's `.env`. Non-ADW adopters set them manually via `gh secret set`. The README is updated with a "Manual secret setup" section to document this.

## User Story

As a maintainer of a freshly-cloned target repository
I want a single `depaudit setup` invocation to scaffold every depaudit artifact, baseline every existing finding, and commit / open a PR for that change
So that depaudit's gate is enforcing on day one without me hand-authoring six files or memorising a baseline procedure.

As a maintainer of a repository whose **Trigger branch** is `main` (or `dev` in a `dev → main` model)
I want `depaudit setup` to choose between committing directly to my current branch and opening a PR based on whether I happen to already be on the trigger branch
So that the setup commit can never bypass the gate it is itself installing.

As a maintainer of an ADW-managed repo
I want `depaudit setup` to be a CLI command ADW's `adwInit.tsx` can shell out to
So that target repo onboarding is a property of `adw_init` rather than a separate manual checklist.

## Problem Statement

Concretely, the gaps this slice closes are:

1. **No `depaudit setup` subcommand exists.** `src/cli.ts:10-25` declares `scan`, `lint`, and `post-pr-comment` only. The `USAGE` string mentions no setup command. ADW's `adwInit.tsx` (in the sibling `adws` repo) has no shell-out target and the PRD `:153` "Bootstrap" section has no code home.

2. **No `DepauditSetupCommand` composition root exists.** `src/commands/` contains `scanCommand.ts`, `lintCommand.ts`, `postPrCommentCommand.ts`. The PRD `:206` and the ubiquitous-language entry `UBIQUITOUS_LANGUAGE.md:39` both name `DepauditSetupCommand` as the bootstrap composition root. Nothing maps to that name today.

3. **No `CommitOrPrExecutor` deep module exists.** PRD `:203` and `UBIQUITOUS_LANGUAGE.md:47` name `CommitOrPrExecutor` as the deep module that encapsulates "commit directly unless on the production branch, then open a PR". The pattern would otherwise be inlined into the setup composition root, where it would be untestable in isolation. The `OsvScannerAdapter` and `GhPrCommentClient` modules already establish the injectable-`execFile` pattern (`src/modules/osvScannerAdapter.ts`, `src/modules/ghPrCommentClient.ts`); `CommitOrPrExecutor` follows the same pattern for `git` plus `gh pr create` / `gh api`.

4. **No baseline writer for `osv-scanner.toml` exists.** `src/modules/configWriter.ts` today exposes `pruneOsvScannerToml` and `pruneDepauditYml` — both *removal* operations. There is no append/insert path. Baseline writing is an *additive* mutation that must produce well-formed TOML / YAML and round-trip cleanly through the existing loader. A new pair of writer helpers is required.

5. **No template-copy helper exists.** Issue #10 shipped `templates/depaudit-gate.yml` and ensured the template is bundled in the npm `files: ["dist", "templates"]` array (`package.json:19-22`), but nothing reads it from the package and writes it into a target repo. The setup command needs a small file-copy helper that resolves the template's runtime path (via `import.meta.url` to remain ESM-correct after `tsc` compilation), reads it, prepends the trigger-branch header comment, and writes it under `<repoRoot>/.github/workflows/depaudit-gate.yml`.

6. **No CLI surface for `gh repos/:owner/:repo/branches/main`.** `GhPrCommentClient` (`src/modules/ghPrCommentClient.ts`) currently only knows the `repos/:owner/:repo/issues/:n/comments` family of endpoints. Trigger-branch resolution needs at minimum a `branchExistsOnRemote(repo, branch)` and `defaultBranch(repo)` pair — small enough that they live in a new `gitRemoteResolver` module rather than bloating `GhPrCommentClient` (which is scoped to PR comments by name).

7. **No integration-test path covers the setup command end to end.** The codebase's BDD harness expects the CLI binary to be present at `dist/cli.js` and shells out to it (see `runDepaudit` at `features/step_definitions/scan_steps.ts:97-152`). The setup command introduces *write* operations on a real fixture repo plus subprocess calls to `git` and `gh`. Both must be mockable to keep BDD scenarios deterministic.

8. **No README guidance for non-ADW adopters.** Today's README (`README.md:11-23`) lists setup as "copy `.env.sample` to `.env`" with no mention of `depaudit setup`. After this slice, the README should describe the canonical onboarding path (`depaudit setup`) and the manual-secret follow-up step.

## Solution Statement

Introduce one composition root (`DepauditSetupCommand`), three new deep modules (`CommitOrPrExecutor`, `gitRemoteResolver`, plus baseline writer extensions to the existing `configWriter.ts`), one new template-copy helper, and the corresponding CLI wiring + tests. The shape:

- **New `src/commands/depauditSetupCommand.ts`** — composition root. Pure orchestration; every I/O boundary is delegated to a deep module that accepts an injectable `execFile` / `fetch` / `now` for testability. Order of operations matches the PRD `:153-164` step list:

  ```ts
  export interface DepauditSetupOptions {
    cwd?: string;                       // defaults to process.cwd()
    now?: Date;                          // defaults to new Date()
    execFile?: ExecFileFn;               // injected for git/gh; falls back to default
    runScan?: typeof runScanCommand;     // injected for in-process baseline
  }

  export async function runDepauditSetupCommand(options: DepauditSetupOptions = {}): Promise<number>;
  ```

  Behaviour:

  1. Resolve `repoRoot` from `options.cwd ?? process.cwd()`. Verify the directory contains a `.git/` folder; otherwise exit 2 with `error: <path> is not a git repository`.
  2. Resolve `repo` (`owner/name`) by parsing `git remote get-url origin`. If parsing fails (no remote, SSH form unrecognised), exit 2.
  3. Discover ecosystems: `await discoverManifests(repoRoot)`; reduce to a sorted unique list of `Ecosystem` strings.
  4. Resolve the trigger branch via `gitRemoteResolver.resolveTriggerBranch(repo, { execFile })`.
  5. Scaffold `.github/workflows/depaudit-gate.yml` from the packaged template via the template-copy helper. Prepend a header comment line (`# generated by depaudit setup at <ISO>; trigger branch: <branch>`).
  6. Scaffold `osv-scanner.toml` (or skip if a non-empty file already exists; idempotency).
  7. Scaffold `.depaudit.yml` (or skip if it already exists). Detected ecosystems become `policy.ecosystems` (sorted, deduplicated). Empty `commonAndFine` and `supplyChainAccepts` arrays.
  8. Append `.depaudit/findings.json` to `.gitignore` (idempotent).
  9. Run the first scan: `await options.runScan(repoRoot, { format: "markdown" })`. Capture the `ScanResult`.
  10. Baseline: pass the classified findings into the new baseline writer functions (see below). The writer skips findings already classified as `accepted` / `whitelisted` / `expired-accept` (they would otherwise duplicate existing entries or silently extend expired ones).
  11. Decide: `await commitOrPrExecutor.execute({ repoRoot, repo, triggerBranch, scaffoldedFiles, execFile })`.
  12. Print a single multi-line summary to stdout listing the trigger branch, the scaffolded files, the baseline entry counts, and the commit-or-PR action taken.

  Exit-code contract:
  - `0` — every step succeeded.
  - `1` — recoverable runtime failure (scan failed, baseline write failed, git failed, gh failed).
  - `2` — invalid invocation (path not a git repo, missing origin remote, malformed CLI args).

- **New `src/modules/gitRemoteResolver.ts`** — deep module exporting:

  ```ts
  export interface GitRemoteResolverOptions {
    execFile?: ExecFileFn;
  }

  export async function resolveRepo(repoRoot: string, opts?: GitRemoteResolverOptions): Promise<string>;
  // -> "owner/name" parsed from `git -C <repoRoot> remote get-url origin`.
  // Throws GitRemoteError on failure.

  export async function resolveTriggerBranch(repo: string, opts?: GitRemoteResolverOptions): Promise<string>;
  // -> "main" if `gh api repos/<repo>/branches/main` returns 200; else
  //    `gh api repos/<repo> --jq .default_branch` value.
  // Throws GhApiError on failure.

  export async function branchExistsOnRemote(repo: string, branch: string, opts?: GitRemoteResolverOptions): Promise<boolean>;
  ```

  Implementation pattern mirrors `GhPrCommentClient`: injectable `execFile`, default `promisify(childProcess.execFile)`, named error class `GitRemoteError`. `gh api repos/<repo>/branches/main` returns exit code 0 + JSON on success, non-zero exit + an "HTTP 404" stderr line on miss; the resolver detects 404 by inspecting the stderr (matches `gh`'s actual output format) and falls back to the default-branch endpoint.

- **New `src/modules/commitOrPrExecutor.ts`** — deep module exporting:

  ```ts
  export type CommitOrPrAction =
    | { kind: "commit"; branch: string; commitSha: string }
    | { kind: "pr"; branch: string; prUrl: string };

  export interface CommitOrPrExecutorOptions {
    repoRoot: string;
    repo: string;             // "owner/name"
    triggerBranch: string;    // resolved by gitRemoteResolver
    pathsToCommit: string[];  // every scaffolded/mutated file path
    commitMessage?: string;   // defaults to "depaudit: bootstrap"
    prTitle?: string;
    prBody?: string;
    execFile?: ExecFileFn;
  }

  export async function execute(options: CommitOrPrExecutorOptions): Promise<CommitOrPrAction>;
  ```

  Behaviour:
  1. `git -C <repoRoot> rev-parse --abbrev-ref HEAD` → `currentBranch`.
  2. `git -C <repoRoot> add <pathsToCommit>` for every path.
  3. If `currentBranch !== triggerBranch`:
     - `git -C <repoRoot> commit -m <commitMessage>`.
     - `git -C <repoRoot> rev-parse HEAD` → `commitSha`.
     - Return `{ kind: "commit", branch: currentBranch, commitSha }`.
  4. If `currentBranch === triggerBranch`:
     - Pick a non-colliding branch name: starting at `depaudit-setup`, append `-2`, `-3`, … until `git ls-remote --exit-code origin <branch>` returns non-zero (branch absent on the remote).
     - `git -C <repoRoot> checkout -b <branch>`.
     - `git -C <repoRoot> commit -m <commitMessage>`.
     - `git -C <repoRoot> push --set-upstream origin <branch>`.
     - `gh pr create --repo <repo> --base <triggerBranch> --head <branch> --title <prTitle> --body <prBody>` → captures the PR URL from stdout.
     - Return `{ kind: "pr", branch, prUrl }`.

  Failure modes raise `CommitOrPrExecutorError` carrying the failed stage label so the caller can produce a precise stderr message. `--no-verify` is **not** used; pre-commit hooks are honoured.

- **Extend `src/modules/configWriter.ts`** with two additive helpers:

  ```ts
  export interface BaselineEntry {
    package: string;
    version: string;
    findingId: string;
    expires: string;       // ISO yyyy-mm-dd
    reason: string;        // "baselined at install"
  }

  export interface BaselineCveEntry {
    id: string;
    ignoreUntil: string;   // ISO yyyy-mm-dd
    reason: string;
  }

  export async function appendDepauditYmlBaseline(filePath: string, entries: BaselineEntry[]): Promise<number>;
  export async function appendOsvScannerTomlBaseline(filePath: string, entries: BaselineCveEntry[]): Promise<number>;
  ```

  - `appendDepauditYmlBaseline` parses the file with `parseDocument`, gets the `supplyChainAccepts` sequence, appends one item per entry (skipping any whose `(package, version, findingId)` already exists in the file — idempotency), writes back via `doc.toString()`. Comment / formatting preservation is automatic because `yaml`'s CST API is in use.
  - `appendOsvScannerTomlBaseline` reads the file, appends one `[[IgnoredVulns]]` block per entry (with `id`, `ignoreUntil`, `reason` keys), and writes back. Existing blocks (matched by `id`) are skipped. Idempotency is preserved across re-runs of `depaudit setup`. The TOML block is written in the canonical formatting used by the existing fixtures (`src/modules/__tests__/fixtures/auto-prune/with-orphan.toml`) so round-trips through `loadOsvScannerConfig` are clean.

- **New `src/modules/templateInstaller.ts`** — small helper:

  ```ts
  export async function installGateWorkflow(
    repoRoot: string,
    triggerBranch: string,
    options: { now?: Date } = {}
  ): Promise<{ destPath: string }>;
  ```

  - Resolves `templates/depaudit-gate.yml` via `new URL("../../templates/depaudit-gate.yml", import.meta.url)` so it works both from `src/` (during tests) and from `dist/` (after `tsc`).
  - Reads the file, prepends a header comment block:
    ```
    # generated by depaudit setup at <ISO>
    # trigger branch: <branch>
    ```
  - Writes the result to `<repoRoot>/.github/workflows/depaudit-gate.yml`, creating `.github/workflows/` if missing.
  - Idempotent: if the destination already exists with byte-identical content (modulo the header timestamp), the file is not rewritten. If it exists with different content, the helper refuses to overwrite (returns no-op + a stderr breadcrumb). This prevents `depaudit setup --force` style accidents.

- **New `src/commands/__tests__/depauditSetupCommand.test.ts`** — integration tests:
  - Feature-branch path: fixture repo whose current branch is `feature/x`; assert files are scaffolded, baseline runs, and a single direct commit lands on `feature/x`.
  - Trigger-branch path: fixture repo whose current branch is `main`; assert a `depaudit-setup` branch is created, push happens, `gh pr create` is invoked.
  - Both paths use a mocked `execFile` (same idiom as `GhPrCommentClient` tests at `src/modules/__tests__/ghPrCommentClient.test.ts`).

- **New `src/modules/__tests__/commitOrPrExecutor.test.ts`** — unit tests with mocked `execFile`:
  - `currentBranch === triggerBranch` → PR path is exercised.
  - `currentBranch !== triggerBranch` → commit path is exercised.
  - Branch-collision: first `depaudit-setup` exists on remote → resolves to `depaudit-setup-2`; second collision → `depaudit-setup-3`.
  - Failure paths: `git commit` non-zero exit → `CommitOrPrExecutorError("commit")`. `gh pr create` non-zero → `CommitOrPrExecutorError("pr")`.

- **New `src/modules/__tests__/gitRemoteResolver.test.ts`** — unit tests with mocked `execFile`:
  - `gh api repos/<repo>/branches/main` returns success → `resolveTriggerBranch` returns `main`.
  - Same call returns 404 → falls back to `gh api repos/<repo> --jq .default_branch` and returns its value (e.g. `develop`).
  - `git remote get-url origin` returns `git@github.com:owner/name.git` → `resolveRepo` returns `owner/name`.
  - Same call returns `https://github.com/owner/name.git` → `resolveRepo` returns `owner/name`.

- **New `src/modules/__tests__/templateInstaller.test.ts`** — unit tests:
  - Writes the workflow into a freshly-created temp dir.
  - Re-running with byte-identical content produces no write (mtime preserved).
  - Re-running with diverged content does not overwrite.

- **New `src/modules/__tests__/configWriter.test.ts` extensions** — `appendDepauditYmlBaseline` and `appendOsvScannerTomlBaseline` round-trip tests against the existing auto-prune fixtures.

- **CLI wiring** — `src/cli.ts` gains a `setup` branch in the dispatcher mirroring the `scan` / `lint` / `post-pr-comment` shape. `USAGE` gets a single new line under `Commands:`. The setup command accepts an optional positional path (`depaudit setup [path]`).

- **BDD scenarios** — `features/setup_command.feature` (tag `@adw-12`) covers the externally-observable behaviour: trigger-branch resolution under both `main`-exists and `default-only` mocks, scaffolded-file existence and content checks, baseline-entry counts and shape, and the commit-vs-PR decision under each branch condition. Step definitions live in `features/step_definitions/setup_command_steps.ts` and re-use `mockGhBinary.ts` (extended with new state fields for `branches/main` 200/404 and `default_branch` JSON responses, and for `gh pr create` URL response). A new `mockGitBinary.ts` helper provides the same "mock binary in temp dir, `PATH`-prepended" pattern for `git`.

- **README update** — adds a "Manual setup (non-ADW)" section that walks through `depaudit setup` and the follow-up `gh secret set` commands for `SOCKET_API_TOKEN` and `SLACK_WEBHOOK_URL`. Existing "Setup" section becomes "Setup (depaudit's own development env)" to avoid confusion between the two.

The end result: every previously-shipped slice (`ManifestDiscoverer`, `ConfigLoader`, `Linter`, `FindingMatcher`, `OsvScannerAdapter`, `SocketApiClient`, `JsonReporter`, `MarkdownReporter`, `SlackReporter`, `StateTracker`, `GhPrCommentClient`, `templates/depaudit-gate.yml`) becomes reachable from a single `depaudit setup` invocation. ADW slice 16 (`adwInit.tsx` propagating secrets) is the only piece that remains gated behind the ADW repo, as the issue notes.

## Relevant Files

Use these files to implement the feature:

- `specs/prd/depaudit.md` — parent PRD. Bootstrap section (`:153-164`) is the normative spec for the order of operations. User stories 11, 12, 13, 14, and 27 (`:45-77`) are the acceptance targets. Module name `DepauditSetupCommand` (`:206`) and `CommitOrPrExecutor` (`:203`) are the canonical identifiers. Baseline-decay note (`:278`) documents *why* the 90-day expiry plus boilerplate `reason` is correct rather than apologetic.
- `README.md` — project overview; the post-slice update adds a "Manual setup (non-ADW)" section describing the `depaudit setup` flow and the manual `gh secret set` follow-up.
- `UBIQUITOUS_LANGUAGE.md` — domain glossary. **Trigger branch** (`:32`), **Baseline** (`:11`), **Acceptance** (`:8`), **Acceptance Register** (`:9`) are the canonical terms used throughout the implementation; their definitions must guide naming in code and stdout messages.
- `src/cli.ts` — CLI entry; the new `setup` subcommand is wired here following the pattern of the existing `scan` / `lint` / `post-pr-comment` cases (`:83-134`).
- `src/commands/scanCommand.ts` — composition-root pattern reference. The setup command follows the same shape (`runScanCommand` returns a `ScanResult`; `runDepauditSetupCommand` returns an exit code) and re-uses `runScanCommand` directly to perform the baseline scan.
- `src/commands/postPrCommentCommand.ts` — composition-root pattern reference for option-injection (`PostPrCommentOptions` includes `ghClient` and `slackReporter` as injectable boundaries; `DepauditSetupOptions` mirrors with `runScan`, `execFile`).
- `src/commands/__tests__/postPrCommentCommand.test.ts` — integration-test reference. The same `makeMockGhClient` factory pattern (`:13-41`) plus the env-save/restore `beforeEach`/`afterEach` discipline (`:50-68`) is the right shape for `depauditSetupCommand.test.ts`.
- `src/modules/manifestDiscoverer.ts` — re-used as-is for ecosystem detection. The setup command reduces the `Manifest[]` it returns into a sorted `Ecosystem[]` for the `.depaudit.yml` `policy.ecosystems` field.
- `src/modules/configLoader.ts` — re-used as-is to round-trip the freshly-scaffolded `.depaudit.yml` and `osv-scanner.toml` (so the baseline writer's output is verified to lint clean by an in-process `lintDepauditConfig` call before the commit step).
- `src/modules/configWriter.ts` — extended with two new functions: `appendDepauditYmlBaseline` and `appendOsvScannerTomlBaseline`. The existing `pruneDepauditYml` (`:15-55`) shape — read, parse with `parseDocument`, mutate `YAMLSeq.items`, write back — is the model for `appendDepauditYmlBaseline`. The TOML line-range manipulation in `pruneOsvScannerToml` (`:65-150`) is the model for `appendOsvScannerTomlBaseline` (which appends a new block at EOF rather than removing one).
- `src/modules/findingMatcher.ts` — `ClassifiedFinding` semantics (`:6-93`) drive the baseline writer's filter: only `category === "new"` findings become baseline entries; `accepted` / `whitelisted` skip; `expired-accept` are deferred to the maintainer.
- `src/modules/ghPrCommentClient.ts` — pattern source for the `execFile` injection idiom and the named error class (`GhApiError` at `:19-27`). `CommitOrPrExecutor` and `gitRemoteResolver` follow the identical shape with `CommitOrPrExecutorError` and `GitRemoteError`.
- `src/modules/__tests__/ghPrCommentClient.test.ts` — pattern source for unit tests with mocked `execFile`; the test cases for `listPrComments` / `createPrComment` (`:18-114`) demonstrate the `let capturedArgs: readonly string[]` capture pattern that `commitOrPrExecutor.test.ts` and `gitRemoteResolver.test.ts` both use.
- `src/modules/jsonReporter.ts` — `isFindingsJsonGitignored` (`:43-54`) is the source of the gitignore-detection idiom; the setup command's `.gitignore` mutation is the *write* counterpart that suppresses that warning.
- `src/modules/__tests__/configWriter.test.ts` — pattern source for fixture-copy round-trip tests. `copyFixture` (`:12-18`) and `makeSca` / `makeVuln` factories (`:20-36`) extend cleanly to baseline-append tests.
- `src/types/depauditConfig.ts` — `DEFAULT_DEPAUDIT_CONFIG` (`:45-56`) is the seed for the scaffolded `.depaudit.yml`. `SUPPORTED_ECOSYSTEMS` (`:58`) is the canonical ecosystem set that `policy.ecosystems` validates against.
- `src/types/finding.ts` — `Ecosystem`, `FindingSource`, `Finding`. The baseline writer dispatches on `Finding.source` to decide which file the entry lands in.
- `src/types/osvScannerConfig.ts` — `IgnoredVuln` (`:1-6`) is the shape of the CVE baseline entry. `LintMessage` / `LintResult` / `ConfigParseError` (`:13-39`) are the lint contract the setup command's pre-commit lint pass relies on.
- `src/types/scanResult.ts` — `ScanResult` (`:3-9`) is what `runScanCommand` returns; the setup command reads `result.findings` for baseline classification and `result.exitCode` to decide whether the baseline-and-commit step should proceed (it does proceed regardless of exit code: a non-zero exit just means there are findings, which is exactly when baselining is most useful).
- `templates/depaudit-gate.yml` — copied verbatim into target repos. The setup command never edits it; it only prepends a header comment for the trigger-branch breadcrumb.
- `package.json` — `"files": ["dist", "templates"]` (`:19-22`) already publishes the template; no change required. `bin.depaudit` (`:6-8`) already points at `./dist/cli.js`; the new `setup` subcommand is reachable as `depaudit setup` with no further wiring.
- `features/support/world.ts` — extended with new fields (`gitMock?`, `setupFixturePath?`, `setupResolvedBranch?`) following the pattern of the existing `ghMock` / `slackMock` additions (`:46-56`).
- `features/support/mockGhBinary.ts` — extended with new state fields for `branches/main` (200/404) and `default_branch` JSON responses, and for `gh pr create` URL output. The existing CJS-script-emitted-into-temp-dir pattern (`:28-132`) is preserved.
- `features/step_definitions/depaudit_gate_workflow_steps.ts` — pattern source for template-content assertions; the new `setup_command_steps.ts` re-uses the YAML-parse-then-assert idiom (`:36-44`).
- `features/step_definitions/scan_steps.ts` — pattern source for the BDD `runDepaudit` helper (`:97-152`). `setup_command_steps.ts` re-uses it directly to invoke `depaudit setup <fixture>`.
- `app_docs/feature-e1layl-github-actions-gate-state-tracker.md` — confirms the gate template's contract, the StateTracker / GhPrCommentClient module shapes, and the post-pr-comment subcommand's exit-code semantics.
- `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md` — confirms that the gate template already includes the `SLACK_WEBHOOK_URL` env wire for the post-pr-comment step (`templates/depaudit-gate.yml:43-46`); the setup command does not need to mutate this.
- `app_docs/feature-5sllud-depaudit-yml-schema-finding-matcher.md` — confirms the four-way classification semantics that the baseline writer's filter relies on.
- `app_docs/feature-2rdowb-json-reporter.md` — confirms the gitignore-warning behaviour the setup command pre-empts by appending `.depaudit/findings.json` to `.gitignore`.
- `.adw/project.md` — module-layout conventions and validation commands.
- `.adw/commands.md` — `bun add {library}` install command and the `bun run lint` / `bun run typecheck` / `bun run build` / `bun test` / `bun run test:e2e` validation pipeline.

### New Files

- `src/commands/depauditSetupCommand.ts` — composition root for `depaudit setup`. Exports `runDepauditSetupCommand(options): Promise<number>`.
- `src/commands/__tests__/depauditSetupCommand.test.ts` — integration tests exercising both branch paths.
- `src/modules/commitOrPrExecutor.ts` — deep module wrapping the commit-vs-PR decision; injectable `execFile`; named `CommitOrPrExecutorError` for failure-stage attribution.
- `src/modules/__tests__/commitOrPrExecutor.test.ts` — unit tests with mocked `execFile` covering both branch paths, the branch-collision suffix logic, and failure-path error attribution.
- `src/modules/gitRemoteResolver.ts` — deep module exporting `resolveRepo`, `resolveTriggerBranch`, `branchExistsOnRemote`. Wraps `git remote get-url origin` and `gh api`.
- `src/modules/__tests__/gitRemoteResolver.test.ts` — unit tests with mocked `execFile`; one case per remote-URL form (SSH, HTTPS, malformed) and per branch-resolution outcome.
- `src/modules/templateInstaller.ts` — small helper that copies the packaged gate workflow into `<repoRoot>/.github/workflows/`, prepending a generated-at / trigger-branch header comment.
- `src/modules/__tests__/templateInstaller.test.ts` — unit tests covering the happy path, idempotent re-runs, and non-overwrite of diverged files.
- `features/setup_command.feature` — BDD scenarios tagged `@adw-12` covering: feature-branch direct-commit path, trigger-branch open-PR path, branch resolution under both `main`-present and `main`-absent mocks, scaffolded-file existence + content assertions, baseline-entry shape (`reason: "baselined at install"`, `expires: today + 90d`), `.gitignore` append idempotency, double-run idempotency.
- `features/step_definitions/setup_command_steps.ts` — step definitions for the above scenarios. Re-uses `runDepaudit` from `scan_steps.ts`.
- `features/support/mockGitBinary.ts` — companion to `mockGhBinary.ts`; emits a `git` shim binary into a temp dir whose subcommands (`rev-parse --abbrev-ref HEAD`, `add`, `commit`, `checkout -b`, `push`, `ls-remote`) are configurable per scenario via a state file.
- `fixtures/setup-clean-feature-branch/` — minimal git-repo fixture (`git init`-bootstrapped, single npm package.json, current branch `feature/init`) used by the feature-branch BDD scenario.
- `fixtures/setup-clean-prod-branch/` — same shape but the current branch is `main`; exercises the open-PR path.
- `fixtures/setup-with-baseline-cve/` — fixture pinning a known CVE; exercises baseline-write of an `[[IgnoredVulns]]` block.
- `fixtures/setup-with-baseline-supply-chain/` — fixture whose mock-Socket API surfaces a supply-chain alert; exercises baseline-write of a `supplyChainAccepts` entry.
- `fixtures/setup-default-branch-develop/` — fixture whose mock `gh api repos/.../branches/main` returns 404 and whose default branch is `develop`; exercises the default-branch fallback.
- `fixtures/setup-no-manifests/` — empty repo; exercises the `policy.ecosystems: auto` no-narrowing path.

## Implementation Plan

### Phase 1: Foundation

Build the small reusable boundaries the composition root will compose. None of these depend on each other.

1. `gitRemoteResolver.ts` (and its tests) — pure `execFile`-wrapping module. No file I/O, no other module dependencies.
2. `templateInstaller.ts` (and its tests) — small file-system helper; depends only on `node:fs/promises` and `import.meta.url`.
3. `configWriter.ts` extensions — `appendDepauditYmlBaseline` and `appendOsvScannerTomlBaseline`. Mirror the existing prune helpers in shape and idempotency.
4. `commitOrPrExecutor.ts` (and its tests) — depends on `gitRemoteResolver`'s `branchExistsOnRemote` for collision-detection.

### Phase 2: Core Implementation

Wire the composition root that orchestrates the steps in PRD order.

5. `depauditSetupCommand.ts` — orchestrates `discoverManifests` → `resolveTriggerBranch` → `templateInstaller.installGateWorkflow` → scaffold `osv-scanner.toml` / `.depaudit.yml` → append `.gitignore` → `runScanCommand` → baseline writers → `commitOrPrExecutor.execute` → stdout summary.
6. `src/cli.ts` — add the `setup` subcommand branch in the dispatcher; update `USAGE`.

### Phase 3: Integration

Cover the externally-observable behaviour with BDD scenarios and update README guidance.

7. `features/setup_command.feature` + `features/step_definitions/setup_command_steps.ts` + `features/support/mockGitBinary.ts` + extension to `features/support/mockGhBinary.ts` + the seven new fixture directories.
8. `README.md` updates.
9. Run the full validation pipeline.

## Step by Step Tasks

Execute every step in order, top to bottom.

### Task 1 — Create `src/modules/gitRemoteResolver.ts`

- New file. Exports `resolveRepo`, `resolveTriggerBranch`, `branchExistsOnRemote`, plus a named `GitRemoteError` class.
- Mirror the `GhPrCommentClient` injectable-`execFile` pattern (`src/modules/ghPrCommentClient.ts:8-13`). Default `execFile` is `promisify(childProcess.execFile)` typed as `ExecFileFn`.
- `resolveRepo(repoRoot)`:
  - Run `git -C <repoRoot> remote get-url origin`.
  - Parse the URL: support `git@github.com:owner/name.git` (SSH), `https://github.com/owner/name.git` (HTTPS), `https://github.com/owner/name` (HTTPS no .git).
  - Return `owner/name`. Throw `GitRemoteError("could not resolve owner/name from remote URL", originalUrl)` on failure.
- `resolveTriggerBranch(repo)`:
  - Run `gh api repos/<repo>/branches/main`.
  - On exit 0 → return `"main"`.
  - On exit non-zero with stderr containing `HTTP 404` → fall through to default-branch resolution.
  - Otherwise → throw `GhApiError(...)` (re-use the existing class from `ghPrCommentClient.ts`).
  - Default-branch fallback: `gh api repos/<repo> --jq .default_branch`. Trim, return.
- `branchExistsOnRemote(repo, branch)`:
  - Run `git ls-remote --exit-code origin <branch>`.
  - Return `true` on exit 0; `false` on exit 2 (the documented "no match" code from `git ls-remote`); throw on any other code.

### Task 2 — Unit-test `gitRemoteResolver`

- `src/modules/__tests__/gitRemoteResolver.test.ts`. Cover:
  - SSH remote URL → parses to `owner/name`.
  - HTTPS remote URL → parses to `owner/name`.
  - HTTPS without `.git` suffix → parses to `owner/name`.
  - Malformed URL → throws `GitRemoteError`.
  - `gh api repos/.../branches/main` exit 0 → `resolveTriggerBranch` returns `main`.
  - Same call non-zero with `HTTP 404` stderr → falls back to `default_branch` endpoint.
  - Default-branch endpoint returns `develop` → `resolveTriggerBranch` returns `develop`.
  - `git ls-remote` exit 0 → `branchExistsOnRemote` returns `true`.
  - `git ls-remote` exit 2 → `branchExistsOnRemote` returns `false`.

### Task 3 — Create `src/modules/templateInstaller.ts`

- New file. Exports `installGateWorkflow(repoRoot, triggerBranch, options)`.
- Resolve the packaged template path via `new URL("../../templates/depaudit-gate.yml", import.meta.url)`. This works both at test time (where `import.meta.url` resolves under `src/`) and at runtime (where it resolves under `dist/`). The relative path `../../templates/depaudit-gate.yml` is correct for both because the published package layout is `dist/modules/templateInstaller.js` → `../../templates/depaudit-gate.yml`.
- Read the template, prepend a two-line header comment:
  ```
  # generated by depaudit setup at <now.toISOString()>
  # trigger branch: <triggerBranch>
  ```
- Write to `<repoRoot>/.github/workflows/depaudit-gate.yml`, creating intermediate directories with `mkdir({ recursive: true })`.
- Idempotency: if the destination exists already, read it; if its body (after stripping any prior `# generated by depaudit setup` header lines) matches the new body byte-for-byte, do not write (return `{ destPath, written: false }`). If bodies differ, do not overwrite — return `{ destPath, written: false, conflict: true }` and let the caller print a warning.

### Task 4 — Unit-test `templateInstaller`

- `src/modules/__tests__/templateInstaller.test.ts`. Cover:
  - Happy path: writes the workflow into a freshly-created temp dir; resolves the path correctly.
  - Header comment is present and references the trigger branch.
  - Re-run with byte-identical body → no write (no `conflict` flag).
  - Re-run with diverged body → no overwrite, returns `conflict: true`.

### Task 5 — Extend `src/modules/configWriter.ts` with baseline append helpers

- Add `appendDepauditYmlBaseline(filePath, entries)`:
  - If `entries.length === 0` return 0.
  - `parseDocument` the file. Get `supplyChainAccepts` as a `YAMLSeq`. If absent, create one and assign at the document root.
  - Build a `Set<string>` of existing `(package, version, findingId)` keys.
  - For each entry whose key is NOT in the set, append a new YAML map node to the sequence with `package`, `version`, `findingId`, `expires`, `reason` keys.
  - Write back with `doc.toString()`. Return the number of entries appended.
- Add `appendOsvScannerTomlBaseline(filePath, entries)`:
  - If `entries.length === 0` return 0.
  - Read the file. Parse with `smol-toml` to enumerate existing `[[IgnoredVulns]]` ids.
  - Build a `Set<string>` of existing ids.
  - For each entry whose `id` is NOT in the set, append a TOML block at EOF in canonical formatting (matching `src/modules/__tests__/fixtures/auto-prune/with-orphan.toml`):
    ```
    
    [[IgnoredVulns]]
    id = "<id>"
    ignoreUntil = <yyyy-mm-dd>
    reason = "<reason>"
    ```
  - Write back. Return the number of entries appended.

### Task 6 — Extend `src/modules/__tests__/configWriter.test.ts` with baseline tests

- Cover `appendDepauditYmlBaseline`:
  - Append to a file with empty `supplyChainAccepts: []`.
  - Append when the key is missing from the file (auto-create the sequence).
  - Idempotent: appending an entry whose `(package, version, findingId)` already exists returns 0 and leaves the file byte-identical.
  - Round-trip: post-write file parses cleanly via `loadDepauditConfig` and lints clean via `lintDepauditConfig`.
- Cover `appendOsvScannerTomlBaseline`:
  - Append a single block to an empty file (just the header comment).
  - Append multiple blocks; ensure separator newlines render correctly.
  - Idempotent: appending an entry whose `id` already exists returns 0 and leaves the file byte-identical.
  - Round-trip: post-write file parses cleanly via `loadOsvScannerConfig` and lints clean via `lintOsvScannerConfig`.

### Task 7 — Create `src/modules/commitOrPrExecutor.ts`

- New file. Exports `execute(options)`, `CommitOrPrAction` discriminated-union type, and a named `CommitOrPrExecutorError` class.
- Mirror the `GhPrCommentClient` injectable-`execFile` pattern.
- Behaviour:
  1. `git -C <repoRoot> rev-parse --abbrev-ref HEAD` → `currentBranch`.
  2. `git -C <repoRoot> add <pathsToCommit>` (one call with all paths).
  3. Branch decision:
     - `currentBranch !== triggerBranch`:
       - `git -C <repoRoot> commit -m <commitMessage>` (default `commitMessage`: `"depaudit: bootstrap"`).
       - `git -C <repoRoot> rev-parse HEAD` → `commitSha`.
       - Return `{ kind: "commit", branch: currentBranch, commitSha }`.
     - `currentBranch === triggerBranch`:
       - Choose a non-colliding branch name. Iterate `depaudit-setup`, `depaudit-setup-2`, `depaudit-setup-3`, … calling `branchExistsOnRemote` (re-imported from `gitRemoteResolver`). Stop at the first absent name.
       - `git -C <repoRoot> checkout -b <branch>`.
       - `git -C <repoRoot> commit -m <commitMessage>`.
       - `git -C <repoRoot> push --set-upstream origin <branch>`.
       - `gh pr create --repo <repo> --base <triggerBranch> --head <branch> --title <prTitle> --body <prBody>`. Capture the URL from stdout (it's the only line `gh pr create` prints on success).
       - Return `{ kind: "pr", branch, prUrl }`.
  4. Wrap each subprocess call in try/catch and re-throw as `CommitOrPrExecutorError(stage, originalMessage)` where `stage` is one of `"add" | "commit" | "checkout" | "push" | "pr" | "branch-collision"`.
- Do NOT pass `--no-verify` to `git commit`. Pre-commit hooks remain in force; if a hook fails, the executor surfaces the failure with `stage: "commit"`.

### Task 8 — Unit-test `commitOrPrExecutor`

- `src/modules/__tests__/commitOrPrExecutor.test.ts`. Cover:
  - `currentBranch === triggerBranch` → exercises the PR path; `gh pr create` invocation arguments are asserted byte-for-byte.
  - `currentBranch !== triggerBranch` → exercises the commit path; no `git push` call appears in the captured invocation log.
  - Branch-collision: mock `branchExistsOnRemote` to return `true` for `depaudit-setup` and `depaudit-setup-2`, `false` for `depaudit-setup-3`. Assert the executor lands on `depaudit-setup-3`.
  - Failure attribution: stub `git commit` to reject with code 1 → expect `CommitOrPrExecutorError` with `stage === "commit"`. Same for `gh pr create` → `stage === "pr"`.
  - Verify `git commit` is invoked WITHOUT `--no-verify`.

### Task 9 — Create `src/commands/depauditSetupCommand.ts`

- New file. Exports `runDepauditSetupCommand(options): Promise<number>`.
- Order of operations exactly as in the Solution Statement above.
- Path resolution:
  - `cwd = options.cwd ?? process.cwd()`.
  - Verify `<cwd>/.git` exists (use `access` from `node:fs/promises`); else write `error: <cwd> is not a git repository\n` to stderr and return 2.
- Error reporting: each step is wrapped in `try / catch` that writes a precise stderr line and returns `1` (or `2` for invocation-shape errors) without re-throwing. The exit-code contract above is honoured.
- Stdout summary: emit a single multi-line block at the end:
  ```
  depaudit setup
  ──────────────
  trigger branch: <branch>
  scaffolded:
    .github/workflows/depaudit-gate.yml
    .depaudit.yml
    osv-scanner.toml
    .gitignore (appended)
  baseline:
    osv: <n> entries
    socket: <m> entries
  action: commit <sha>          (or)  pr opened: <url>
  ```
  This text is the human-facing record. It is not consumed by downstream tooling — `/depaudit-triage` reads `.depaudit/findings.json`, not this stdout.

### Task 10 — Integration-test `depauditSetupCommand`

- `src/commands/__tests__/depauditSetupCommand.test.ts`. Cover:
  - Feature-branch path: mock `git rev-parse --abbrev-ref HEAD` → `feature/x`; mock all subsequent `git` / `gh` calls; mock `runScanCommand` injection to return a known `ScanResult` with two new findings (one OSV, one Socket). Assert: scaffolded files exist, baseline writes one `[[IgnoredVulns]]` block + one `supplyChainAccepts` entry with the canonical reason and a `+90d` expiry, executor takes the commit path.
  - Trigger-branch path: same setup but mock `git rev-parse --abbrev-ref HEAD` → `main`; assert executor takes the PR path and `gh pr create` is invoked.
  - Idempotency: run twice in a row against the same fixture; assert the second run is a no-op for scaffolding (no double-write of files), produces zero new baseline entries, and the executor's commit step still runs (the executor itself is idempotent only at the file-state level: if `git status` is clean it returns `{ kind: "commit", commitSha: <prior> }` without making a new commit; the integration test asserts the no-double-commit behaviour).
- Use `mkdtemp` + `git init` to make a real repo per test (since the executor calls real `git` for branch / status operations even with mocked `gh`); then mock `gh` with the existing `makeMockGhClient` pattern adapted for the new endpoints.

### Task 11 — Wire `setup` into `src/cli.ts`

- Add `setup` to the `Commands:` block in the `USAGE` string.
- After the `post-pr-comment` branch in the dispatcher (`src/cli.ts:104-134`), add:
  ```ts
  } else if (subcommand === "setup") {
    try {
      const { runDepauditSetupCommand } = await import(
        "./commands/depauditSetupCommand.js"
      );
      const code = await runDepauditSetupCommand({ cwd: cmdPath ?? process.cwd() });
      process.exit(code);
    } catch (err: unknown) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  }
  ```
- Use the dynamic-import idiom (matches the existing `post-pr-comment` case) so the setup command is not loaded for `scan` / `lint` callers.

### Task 12 — Create `features/support/mockGitBinary.ts`

- Mirror the structure of `features/support/mockGhBinary.ts`. Emit a `git` shim binary into a temp directory; make it executable; expose `binDir`, `logFile`, `stateFile`, `readLog`, `setState`, `readState`, `stop`.
- Supported subcommand stubs (configurable via `MockGitState`):
  - `rev-parse --abbrev-ref HEAD` → emits `currentBranch` from state.
  - `remote get-url origin` → emits `originUrl` from state.
  - `add <paths>` → no-op, returns 0.
  - `commit -m <msg>` → no-op, returns 0; subsequent `rev-parse HEAD` returns `commitSha` from state.
  - `rev-parse HEAD` → emits `commitSha`.
  - `checkout -b <branch>` → records the new branch in the log; subsequent `rev-parse --abbrev-ref HEAD` returns it.
  - `push --set-upstream origin <branch>` → no-op, returns 0.
  - `ls-remote --exit-code origin <branch>` → exit 0 if `branch` is in `existingRemoteBranches`, else exit 2.
- `commit -m` and `push` failure overrides via `commitExitOverride`, `pushExitOverride`.

### Task 13 — Extend `features/support/mockGhBinary.ts`

- Add new state fields:
  - `branchesMain`: `{ exists: boolean, body?: object }` for `gh api repos/.../branches/main` responses.
  - `defaultBranch`: string for `gh api repos/... --jq .default_branch` responses.
  - `prCreateUrl`: string for `gh pr create` stdout.
- Add new endpoint matchers in the embedded CJS script that route to these fields based on the args.

### Task 14 — Create the BDD fixture directories

- `fixtures/setup-clean-feature-branch/` — `package.json` (clean), no `.depaudit.yml`, no `.github/workflows/`, `.git/` initialised by a Before hook (cucumber `Before({ tags: "@adw-12-feature-branch" })` runs `git init` + `git checkout -b feature/init`).
- `fixtures/setup-clean-prod-branch/` — same, current branch is `main`.
- `fixtures/setup-with-baseline-cve/` — `package.json` pinning `semver@5.7.1` (the canonical "one finding" fixture used elsewhere).
- `fixtures/setup-with-baseline-supply-chain/` — `package.json` whose mock-Socket alert produces a supply-chain finding.
- `fixtures/setup-default-branch-develop/` — same as `setup-clean-feature-branch` but mock-gh returns 404 for `branches/main` and `develop` for `default_branch`.
- `fixtures/setup-no-manifests/` — empty repo (no manifests anywhere).

### Task 15 — Write `features/setup_command.feature`

- Tag every scenario `@adw-12`. Add a Background that establishes:
  - The `depaudit` CLI is on PATH.
  - The mock `gh` and `git` binaries are on PATH.
  - The mock Socket server is running (for scenarios that exercise supply-chain baseline writes).
- Scenario list:
  1. **Feature-branch direct commit**: against `setup-clean-feature-branch`. Assert: every scaffolded file exists; `.gitignore` ends with `.depaudit/findings.json`; `git commit` was invoked; `gh pr create` was NOT invoked.
  2. **Trigger-branch open PR**: against `setup-clean-prod-branch`. Assert: scaffolded files exist; `git checkout -b depaudit-setup` was invoked; `git push --set-upstream origin depaudit-setup` was invoked; `gh pr create` was invoked with `--base main --head depaudit-setup`.
  3. **Trigger-branch resolution: `main` exists** → assert workflow header comment includes `trigger branch: main`.
  4. **Trigger-branch resolution: default branch is `develop`** → against `setup-default-branch-develop`; assert workflow header comment includes `trigger branch: develop`.
  5. **Baseline writes a CVE entry**: against `setup-with-baseline-cve`. Assert: post-run `osv-scanner.toml` contains an `[[IgnoredVulns]]` block with `id = "<known CVE>"`, `reason = "baselined at install"`, `ignoreUntil = <today + 90d>`.
  6. **Baseline writes a supply-chain entry**: against `setup-with-baseline-supply-chain`. Assert: post-run `.depaudit.yml` contains a `supplyChainAccepts` entry with `package`, `version`, `findingId`, `reason: "baselined at install"`, `expires: <today + 90d>`.
  7. **Severity threshold filters baseline**: against `setup-with-baseline-cve` whose `.depaudit.yml` is post-scaffold mutated to `severityThreshold: critical`; assert the medium-severity finding is NOT baselined (because the scaffold step writes the default `medium` threshold, this scenario adjusts it via a Then-step file edit and re-runs setup).
  8. **`.gitignore` append idempotency**: run setup twice; assert the second run leaves `.gitignore` byte-identical (no double-line).
  9. **Setup is idempotent on file scaffolding**: run setup twice; assert second run does not overwrite `osv-scanner.toml` or `.depaudit.yml`; baseline writers append zero new entries.
  10. **No manifests → ecosystems stays `auto`**: against `setup-no-manifests`; assert `.depaudit.yml` carries `policy.ecosystems: auto`.
  11. **Branch-collision suffix**: trigger-branch path with mock-git's `existingRemoteBranches: ["depaudit-setup"]`; assert `git checkout -b depaudit-setup-2` was invoked.

### Task 16 — Write step definitions in `features/step_definitions/setup_command_steps.ts`

- Re-use `runDepaudit` from `scan_steps.ts` for the CLI invocation step.
- New steps:
  - `Given a fixture repo at "<path>" whose current branch is "<branch>"` — `git init` if absent; `git checkout -b <branch>`.
  - `Given the mock gh API reports branches/main as <existing|not existing>` — set `mockGh` state.
  - `Given the mock gh API's default branch is "<branch>"` — set `defaultBranch` field.
  - `Then the file "<path>" exists in the fixture` — `access` assertion.
  - `Then the workflow file's header comment references trigger branch "<branch>"` — read the file and assert the header line.
  - `Then the .depaudit.yml at "<path>" contains a supplyChainAccepts entry for package "<pkg>" with reason "baselined at install"` — parse and assert.
  - `Then the osv-scanner.toml at "<path>" contains an [[IgnoredVulns]] entry for id "<id>" with reason "baselined at install"` — parse and assert.
  - `Then the mock git binary log shows "<subcommand>"` — read the mock-git log file and grep.
  - `Then the mock gh binary log shows a pr create call` — read the mock-gh log file and grep for `pr create`.
- After hooks restore mutated fixture files (snapshot-and-restore pattern, mirroring the `@adw-13` orphan-prune scenarios).

### Task 17 — Update `features/support/world.ts`

- Add fields:
  - `gitMock?: import("./mockGitBinary.js").MockGitHandle`
  - `setupFixturePath?: string`
  - `setupResolvedBranch?: string`

### Task 18 — Update `README.md`

- Add a new top-level section "Manual setup (non-ADW)" between "Setup" and "Domain Language" describing:
  1. `npm install -g depaudit`.
  2. `depaudit setup` — what it does, what files it creates.
  3. The follow-up `gh secret set SOCKET_API_TOKEN` and `gh secret set SLACK_WEBHOOK_URL` step (with a note that ADW users get this for free via `adwInit.tsx` in slice 16).
- Rename the existing "Setup" section to "Setup (depaudit's own dev environment)" so the two are not confused.

### Task 19 — Document the slice in `app_docs/`

- Create `app_docs/feature-1j2fia-depauditsetupcommand.md` mirroring the structure of the existing per-slice docs (e.g., `app_docs/feature-2sm4zt-slack-reporter-state-tracker-transitions.md`):
  - Overview, What Was Built, Technical Implementation, Files Modified, Files Added, Key Changes, How to Use, Configuration, Testing, Notes.

### Task 20 — Run the validation pipeline

- Run every command in the `Validation Commands` section below. Every command must exit 0.

## Testing Strategy

### Unit Tests

`.adw/project.md` lacks the `## Unit Tests: enabled` marker. This plan includes unit-test tasks as a documented override, following the same precedent as issues #3, #4, #5, #6, #7, #10, #11, and #13. Justifications, in priority order:

1. **Issue requirement.** The issue explicitly lists "Unit tests for `CommitOrPrExecutor` with mocked `git` / `gh`" under Acceptance criteria.
2. **Pure / boundary module discipline.** `gitRemoteResolver`, `commitOrPrExecutor`, `templateInstaller`, and the new `configWriter` baseline helpers are deep modules with pure or `execFile`-injectable interfaces; the project's `.adw/project.md` Framework Notes mandate Vitest unit coverage for deep modules.
3. **Subprocess-boundary fidelity.** The setup command shells out to `git` and `gh` more aggressively than any prior slice. Unit tests against a captured `execFile` are the only practical way to assert exact argument lists (`git checkout -b <branch>`, `gh pr create --base <branch> --head <branch>`) without a brittle BDD harness running real git operations.
4. **Branch-collision matrix.** The collision-suffix logic in `commitOrPrExecutor` (`depaudit-setup` → `depaudit-setup-2` → `depaudit-setup-3`) is best covered by a fast unit test that mocks `branchExistsOnRemote`'s answer per call rather than by spinning up real remote branches in a fixture repo.

Unit tests to build:

- **`src/modules/__tests__/gitRemoteResolver.test.ts`** — remote-URL parsing across SSH / HTTPS / no-`.git` forms; `resolveTriggerBranch` happy / 404-fallback paths; `branchExistsOnRemote` exit-0 / exit-2 mapping; covered in Task 2.
- **`src/modules/__tests__/templateInstaller.test.ts`** — happy path, idempotent re-run, conflict-on-diverged-content; covered in Task 4.
- **`src/modules/__tests__/configWriter.test.ts`** (extended) — `appendDepauditYmlBaseline` and `appendOsvScannerTomlBaseline` round-trip + idempotency tests; covered in Task 6.
- **`src/modules/__tests__/commitOrPrExecutor.test.ts`** — feature-branch path, trigger-branch path, branch-collision suffix, failure-stage attribution, no-`--no-verify` invariant; covered in Task 8.
- **`src/commands/__tests__/depauditSetupCommand.test.ts`** — composition-root integration tests covering both branch paths plus idempotency; covered in Task 10.

### Edge Cases

- **No `.git/` directory** — exits 2 with a clear message; no scaffolding occurs.
- **No `origin` remote** — exits 2 with a clear message; no scaffolding occurs (the trigger-branch resolver requires an origin URL to make `gh api` calls).
- **Origin URL in unrecognised form** — `GitRemoteError` propagates; exit 2.
- **`gh api repos/.../branches/main` returns a non-404, non-200 status** (e.g., 403 rate-limit) — propagates as `GhApiError` with the exit code; exit 1.
- **`gh pr create` returns a URL line preceded by warnings on stderr** — the executor must capture only the URL from stdout; warnings are forwarded to the user.
- **`.gitignore` already contains `.depaudit/findings.json`** — no double-append; file is byte-identical after.
- **`.depaudit.yml` already exists with custom content** — setup does NOT overwrite. Baseline append still proceeds against the existing file. The stdout summary indicates "scaffold skipped, file already present" for the file in question.
- **`osv-scanner.toml` already exists with `[[IgnoredVulns]]` blocks** — same: no overwrite; baseline append is idempotent (existing ids are not re-added).
- **`depaudit setup` invoked on a freshly-initialised repo with no remote yet** — `git remote get-url origin` exits non-zero; exit 2 with clear message.
- **Severity threshold higher than the only finding's severity** — baseline writes zero entries; stdout summary shows `baseline: osv: 0 / socket: 0`. Setup still commits the scaffolded files.
- **Polyglot repo** — `policy.ecosystems` lists every detected ecosystem in sorted order.
- **Empty repo (no manifests)** — `policy.ecosystems` stays `auto`; baseline is empty.
- **Trigger branch is the same as the current branch but `depaudit-setup` already exists on the remote** — collision suffix kicks in: `depaudit-setup-2`.
- **Pre-commit hook fails** — `CommitOrPrExecutorError("commit")` propagates; exit 1; no PR is opened.
- **`gh pr create` fails (e.g., GH outage)** — `CommitOrPrExecutorError("pr")` propagates; exit 1; the local commit and pushed branch remain (no rollback) so the user can re-attempt the PR open by hand.
- **OSV scanner not on PATH** — first scan throws; setup writes everything else (template, configs, gitignore) but the baseline step is skipped with a stderr breadcrumb. The commit-or-PR step still runs against the scaffolded files. Exit 1.
- **Socket API unavailable** — first scan returns `socketAvailable: false`; supply-chain baseline writes zero entries (the matcher correctly classifies nothing); CVE baseline still runs. Stderr includes the existing "supply-chain unavailable" breadcrumb. Exit 0 if there are no `new` CVE findings; exit 1 otherwise.

## Acceptance Criteria

- [ ] `depaudit setup` succeeds in a freshly-cloned fixture repo with no prior depaudit state (Task 10 integration test, BDD scenarios 1 and 2).
- [ ] Trigger-branch resolution chooses `main` when the remote has it, else the repo's default branch (BDD scenarios 3 and 4; unit tests in Task 2).
- [ ] All scaffolded files match the template; `.github/workflows/depaudit-gate.yml`'s body equals the packaged template plus the generated header comment that references the resolved trigger branch (BDD scenarios 1, 3, 4).
- [ ] Baseline entries honour the configured `severityThreshold`; all carry `reason: "baselined at install"` and `expires: today + 90d` (BDD scenarios 5, 6, 7).
- [ ] `CommitOrPrExecutor` chooses commit vs branch-and-PR per current branch (Task 8 unit tests; BDD scenarios 1 and 2).
- [ ] Branch-collision suffix increments correctly (Task 8 unit test; BDD scenario 11).
- [ ] Integration tests cover both the feature-branch direct-commit path and the trigger-branch open-PR path (Task 10).
- [ ] `CommitOrPrExecutor` unit tests run with mocked `git` and `gh` (Task 8).
- [ ] `.gitignore` append is idempotent (BDD scenario 8).
- [ ] Setup is idempotent on re-run: scaffolding skips existing files; baseline append re-detects existing entries and writes zero new ones (BDD scenario 9; Task 6).
- [ ] No manifests → `policy.ecosystems` remains `auto` (BDD scenario 10).
- [ ] README documents the manual `gh secret set` follow-up for non-ADW adopters.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `bun install` — install any new dependencies (none expected; the new modules use only `node:` built-ins, the existing `yaml` and `smol-toml` packages, and the existing test dependencies).
- `bun run lint` — lint the codebase (per `.adw/commands.md`).
- `bun run typecheck` — confirm zero type errors across the new modules and their tests.
- `bun run build` — produce `dist/commands/depauditSetupCommand.js`, `dist/modules/commitOrPrExecutor.js`, `dist/modules/gitRemoteResolver.js`, `dist/modules/templateInstaller.js`, and the extended `dist/modules/configWriter.js`.
- `bun test` — run all unit + integration tests, including the new `depauditSetupCommand`, `commitOrPrExecutor`, `gitRemoteResolver`, `templateInstaller`, and `configWriter` baseline tests; every test must pass.
- `bun run test:e2e -- --tags "@adw-12"` — run only the new BDD scenarios; every scenario must pass.
- `bun run test:e2e -- --tags "@regression"` — run the full regression suite to confirm no prior slice has regressed (issue numbers 3–11 and 13 each contribute scenarios).
- `node dist/cli.js setup --help` — confirm the new `setup` command appears in the USAGE help text.
- `node dist/cli.js setup fixtures/setup-clean-feature-branch` — manual smoke test against the fixture; confirm exit code 0 and the stdout summary; confirm scaffolded files appear in the fixture (and are restored / cleaned by an After hook in BDD or manually for the smoke test).

## Notes

- **Unit tests override.** `.adw/project.md` lacks `## Unit Tests: enabled`. This plan includes unit-test tasks because the issue explicitly requires them and because subprocess-boundary fidelity (exact `git` / `gh` argument lists, branch-collision suffix logic, failure-stage attribution) is uneconomic to cover by BDD alone. Same precedent as issues #3, #4, #5, #6, #7, #10, #11, and #13.
- **No new runtime dependencies.** Every new module uses `node:fs/promises`, `node:child_process`, `node:util`, the existing `yaml` and `smol-toml` packages, and the already-bundled `templates/depaudit-gate.yml`. No `bun add` calls are required.
- **`CommitOrPrExecutor` is intentionally minimal.** It does not handle PR-template body interpolation, label assignment, reviewer requests, or draft-PR mode. All of those are deferred until a real user need surfaces. The executor's signature accepts `prTitle` and `prBody` so a future caller can pass richer text without a module change.
- **Baseline reason is hard-coded.** `"baselined at install"` is the canonical string per PRD `:162` and `UBIQUITOUS_LANGUAGE.md:11`. It deliberately fails the linter's `>=20 char` rule? No — it is exactly 22 characters including the quotes-stripped value: `baselined at install` is 20 chars. Verified: this satisfies the rule by exactly the minimum margin. If a future rule tightens the minimum, the constant in `depauditSetupCommand.ts` is the single edit point.
- **Trigger branch is recorded in the workflow header but NOT pinned in `on.pull_request.branches`.** PRD `:120` says the workflow is "pinned" to the trigger branch; the packaged template currently does not narrow `on.pull_request` to a specific branch (because the BDD assertion in `features/depaudit_gate_workflow.feature:135` tests for *no* single hard-coded branch). The header comment is the breadcrumb of which branch was resolved, while the workflow remains polite to repos that PR into multiple branches. A future slice may revisit this if the team decides the pinning should be enforced at the workflow level rather than recorded in a comment.
- **`depaudit setup` does not propagate `SOCKET_API_TOKEN` / `SLACK_WEBHOOK_URL`.** This is explicit per the issue body. ADW slice 16 (`adwInit.tsx`) handles secret propagation. Non-ADW adopters run `gh secret set` themselves; the README documents the steps. A future "with-secrets" mode could be added behind a `--set-secrets` flag if the manual-setup ergonomics prove unacceptable.
- **`commitOrPrExecutor.execute` does not roll back on partial failure.** If `git push` succeeds but `gh pr create` fails, the local commit and the pushed branch remain. The user can re-run `gh pr create --repo <repo> --base <triggerBranch> --head <branch>` by hand. Rollback would require detecting the failure stage and `git push --delete origin <branch>` — adding that complexity for a rare error path is deferred until users complain.
- **The `templates/` directory ships in the published package.** Already configured in `package.json:19-22` (`"files": ["dist", "templates"]`). The setup command relies on this; without it, the npm-installed CLI would have no template to copy.
- **Idempotency is the safety net for re-runs.** `depaudit setup` on a repo that already has depaudit installed should be safe: scaffolded files are not overwritten; baseline append skips existing entries; `.gitignore` is left byte-identical. Combined, this means a user can re-run setup at any time without fear of clobbering their config.
- **`expired-accept` findings during baseline.** The setup command does NOT re-baseline expired accepts — silently extending an expired accept by writing a fresh entry would defeat the entire 90-day decay design. Instead, the stdout summary lists expired entries explicitly (`baseline: <n> expired entries surfaced; re-evaluate manually`). This nudges the maintainer to make a real decision per PRD `:280-281`.
- **PR title and body for the trigger-branch path.** Default `prTitle: "depaudit: bootstrap"`; default `prBody`:
  ```
  This PR was opened automatically by `depaudit setup` because setup was invoked while you were on the trigger branch (`<triggerBranch>`).
  
  It scaffolds the depaudit gate workflow, adds `.depaudit.yml` and `osv-scanner.toml`, ensures `.depaudit/findings.json` is gitignored, and baselines every existing finding above the configured severity threshold (`<threshold>`) with a 90-day acceptance.
  
  Review and merge to enable the depaudit gate on subsequent PRs.
  ```
  These are passed into `commitOrPrExecutor.execute` from the composition root; the executor itself stays content-agnostic.
- **Naming alignment with the ubiquitous language.** Stdout text and code identifiers use **trigger branch** (not "production branch" or "main"), **baseline** (not "seed" or "initial scan"), **acceptance** / **acceptance register** (not "ignore list" or "allowlist"). This keeps the codebase aligned with `UBIQUITOUS_LANGUAGE.md`.
