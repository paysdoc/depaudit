# Chore: Close out the v1.0.0 npm release — green CI, correct install name, verified smoke test

## Metadata
issueNumber: `14`
adwId: `8pmyar-hitl-npm-publish-rel`
issueJson: `{"number":14,"title":"HITL: npm publish + release v1.0.0","body":"## Parent PRD\n\n`specs/prd/depaudit.md`\n\n## What to build\n\nCuts the first public release of `depaudit` to npm.\n\nManual steps:\n\n1. Verify all of depaudit#3–#13 are merged and CI is green.\n2. ...\n3. Bump version in `package.json` to `1.0.0`.\n4. Generate / update `CHANGELOG.md`.\n5. Run `npm publish --access public` with an npm token scoped to this package.\n6. Tag the release (`git tag v1.0.0 && git push --tags`) and create a GitHub release with the changelog.\n7. Smoke-test on a fresh machine: `npm install -g depaudit` then `depaudit --version`.\n8. Update README with install instructions and a \"Getting Started\" snippet.\n\n## Acceptance criteria\n\n- [ ] `depaudit` is installable via `npm install -g depaudit`.\n- [ ] Version `1.0.0` is tagged on GitHub.\n- [ ] GitHub release exists with changelog content.\n- [ ] Smoke test passes end-to-end on a fresh machine.\n- [ ] README covers install + basic usage.\n\n## Blocked by\n\n- none\n\n\n- #27\n## User stories addressed\n\n- User story 26\n","state":"OPEN","author":"paysdoc","labels":["hitl"],"createdAt":"2026-04-17T13:27:54Z","comments":[{"author":"paysdoc","createdAt":"2026-09-08T13:10:32Z","body":"## continue"}],"actionableComment":null}`

## Chore Description

Issue #14 is the HITL release chore for v1.0.0. Most of it is **already done** — this chore closes the gap between what shipped and what the acceptance criteria actually require.

### What is already true (verified 2026-09-08)

| Manual step | Status |
|---|---|
| 1. depaudit#3–#13 merged | Done — all of #3, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13 (plus #27) are `CLOSED` |
| 1. CI green | **BROKEN** — latest `main` run `34230781430` failed |
| 3. Version `1.0.0` in `package.json` | Done (`4e41952 chore: release 1.0.0`) |
| 4. `CHANGELOG.md` | Done — Keep-a-Changelog format, `[1.0.0] - 2026-04-26` |
| 5. `npm publish --access public` | Done — `@paysdoc/depaudit@1.0.0` is live on the registry |
| 6. Tag + GitHub release | Done — `v1.0.0` pushed to origin, release published with the changelog body |
| 7. Fresh-machine smoke test | **NOT VERIFIED** |
| 8. README install + Getting Started | Done on `main` (`9d438ab`), with further improvements sitting **uncommitted** in this worktree |

### The three real defects to fix

**1. CI on `main` is red (blocks AC "CI is green").**
`src/modules/__tests__/configWriter.test.ts` has two time-bomb tests. `BASELINE_EXPIRES` is the hard-coded literal `"2026-07-21"` (`configWriter.test.ts:179`), and `appendOsvScannerTomlBaseline`'s round-trip test uses the same literal inline (`configWriter.test.ts:307`). Both tests write a config with that date, then assert `lint.errors` is empty. Today is 2026-09-08, so `lintDepauditConfig` / `lintOsvScannerConfig` correctly flag both entries as **expired** and each assertion sees 1 error instead of 0. Reproduced locally: `Test Files 1 failed | 18 passed`, `Tests 2 failed | 353 passed`, failing at `configWriter.test.ts:242` and `configWriter.test.ts:313`. The production code is correct; the tests are wrong for pinning an absolute future date.

**2. The scaffolded CI gate installs a package that does not exist (blocks AC "`depaudit` is installable").**
`templates/depaudit-gate.yml:29` runs `npm install -g depaudit`. Commit `b5f220e` renamed the package to `@paysdoc/depaudit`, and the unscoped `depaudit` name returns **HTTP 404** on the registry. Every repo bootstrapped by `depaudit setup` therefore gets a gate workflow whose install step fails on the first PR — the headline user journey is broken in the published 1.0.0 tarball. Two assertions pin the stale literal and must move with it: `src/modules/__tests__/depauditGateYml.test.ts:72` and `features/depaudit_gate_workflow.feature:70`. `specs/prd/depaudit.md:107` also still documents the unscoped install.

**3. AC wording vs. reality.** The AC says `npm install -g depaudit`; the package publishes as `@paysdoc/depaudit`. The scoped name is the deliberate, already-published decision (`b5f220e`, live on npm, README updated to match) — do **not** rename or republish under the unscoped name. Treat the scoped name as canonical everywhere and record the reconciliation in the issue when closing.

Because defect 2 ships inside the published `1.0.0` tarball (`templates/` is in `package.json:files`), fixing it in git is not enough for consumers. This chore therefore also prepares a `1.0.1` patch release; the actual `npm publish`, tag and GitHub release remain **HITL manual steps** (`npm whoami` currently returns `E401`, so no token is available to this workflow).

## Relevant Files

Use these files to resolve the chore:

- `README.md` — always-include per `.adw/conditional_docs.md`; already carries Install + Getting Started, but has uncommitted improvements in the working tree that need committing.
- `specs/prd/depaudit.md` — parent PRD named by the issue; `:107` still documents `npm install -g depaudit` (unscoped), `:120` describes the gate workflow's install step.
- `.adw/project.md` — project overview and the Relevant Files table used to scope this plan.
- `.adw/commands.md` — source of the validation commands (`bun run typecheck`, `bun run build`, `bun test`, `bun run test:e2e`).
- `.adw/conditional_docs.md` — checked; only the always-include `README.md` and the parent PRD entries apply to a release chore.
- `src/modules/__tests__/configWriter.test.ts` — holds both time-bomb tests. `:179` (`BASELINE_EXPIRES = "2026-07-21"`), and inline `ignoreUntil: "2026-07-21"` at `:259`, `:272`, `:273`, `:286`, `:307`. Failing assertions at `:242` and `:313`.
- `src/modules/linter.ts` — `lintOsvScannerConfig(config, now = new Date())` at `:85` and `lintDepauditConfig(config, now = new Date())` at `:293`; both take an injectable `now`, which is the mechanism the sibling tests already use.
- `src/modules/__tests__/linter.test.ts` — precedent for the fix: `const NOW = new Date("2026-04-18T00:00:00.000Z")` at `:14`, passed explicitly into the lint calls. Read for the house idiom before editing `configWriter.test.ts`.
- `templates/depaudit-gate.yml` — `:29` runs the 404-ing `npm install -g depaudit`; shipped to consumers via `package.json:files`.
- `src/modules/__tests__/depauditGateYml.test.ts` — `:68`/`:72` assert the workflow contains the literal `"npm install -g depaudit"`.
- `features/depaudit_gate_workflow.feature` — `:68`–`:70`, `@adw-10 @regression` scenario asserting the same literal. Only the quoted argument changes; the Gherkin phrase itself is untouched, so `features/regression/vocabulary.md` needs no update and no step definition changes.
- `package.json` — `name: "@paysdoc/depaudit"`, `version: "1.0.0"`, `files: ["dist", "templates"]`, `bin.depaudit`. Version bump lands here.
- `CHANGELOG.md` — Keep-a-Changelog file; gains the `1.0.1` section.
- `.github/workflows/ci.yml` — the CI definition whose red run must go green (typecheck → build → unit → e2e).
- `src/cli.ts` — `:8` reads the version from `package.json`, `:72`–`:73` implement `--version`; this is what the smoke test exercises.

### New Files

None.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Prepare the workspace and reproduce both defects

- Run `bun install` to make sure dependencies match `bun.lock`.
- Run `bun run test` and confirm exactly 2 failures, both in `src/modules/__tests__/configWriter.test.ts` (lines `242` and `313`), each `expected [ { severity: 'error', …(3) } ] to have a length of +0 but got 1`. This is the red state you are fixing — do not proceed until you have seen it.
- Run `npm view depaudit version` and confirm it 404s, then `npm view @paysdoc/depaudit version` and confirm it prints `1.0.0`. This is the evidence for the template fix.
- Read `src/modules/__tests__/linter.test.ts:14` and the lint call sites around it to absorb the existing `NOW`-injection idiom before writing any test code.

### 2. Fix the time-bomb dates in `configWriter.test.ts`

- Replace the absolute `BASELINE_EXPIRES = "2026-07-21"` constant at `configWriter.test.ts:179` with a date derived from the current date at run time, so the test can never expire again.
- Derive it the way the production baseline does: **today + 90 days is the cap**, so pick a comfortably-inside-cap offset (60 days) and format as `YYYY-MM-DD`. Keep it a module-level `const` computed once, matching the existing `const BASELINE_EXPIRES` shape so the five call sites need no edits.
- Replace the five inline `ignoreUntil: "2026-07-21"` literals (`:259`, `:272`, `:273`, `:286`, `:307`) with the same constant, so a single definition governs every baseline date in the file.
- Leave the `"2027-01-01"` literals in `makeSca` (`:27`) and `makeVuln` (`:35`) alone **only if** they are not lint-asserted; grep their call sites first. If any test path lints them, move them onto the same relative-date helper. (They are used by the prune tests, which assert file content rather than lint results.)
- Do not touch `src/modules/linter.ts` — the linter's expiry behaviour is correct and is what caught this.

### 3. Point the gate workflow template at the published package name

- In `templates/depaudit-gate.yml:29`, change `npm install -g depaudit` to `npm install -g @paysdoc/depaudit`. Leave every other step (`depaudit scan`, `depaudit post-pr-comment`) unchanged — the `bin` name stays `depaudit`, only the package specifier changes.
- Update the assertion in `src/modules/__tests__/depauditGateYml.test.ts:72` to match the new literal, and update the `it(...)` description at `:68` so it still reads truthfully.
- Update the quoted argument in `features/depaudit_gate_workflow.feature:70` to `"npm install -g @paysdoc/depaudit"`. Change only the argument — the Gherkin phrase `Then at least one \`run\` step in the depaudit-gate job contains "..."` is a registered regression phrase and must stay byte-identical, so no step definition and no `features/regression/vocabulary.md` edit is required.
- Update the scenario title at `:68` if it names the old command; otherwise leave it.

### 4. Reconcile the documented install command

- Update `specs/prd/depaudit.md:107` so the CLI-distribution line names `npm install -g @paysdoc/depaudit`, keeping the surrounding sentence intact.
- Check `specs/prd/depaudit.md:120` — it describes the gate workflow installing "depaudit via `npm install -g`" without naming a package; only change it if it pins the bare name.
- Confirm `README.md:28` already says `npm install -g @paysdoc/depaudit` (it does) and leave it.
- Do **not** rewrite the historical `specs/issue-*.md` plan documents — they are point-in-time records of prior slices, not living documentation.

### 5. Commit the pending working-tree documentation changes

- The worktree carries uncommitted edits to `README.md` (adds the "What it does" capability list and a `.env.sample` note under Configuration), `.gitignore` (ADW-copied-command ignores), and three `.claude/skills/*/SKILL.md` + `.claude/commands/install.md` files from the ADW framework upgrade.
- The `README.md` change directly serves AC "README covers install + basic usage" — keep it.
- Review the `.gitignore` and `.claude/` changes with `git diff` and commit them alongside; they are ADW-managed framework files that belong on the branch.

### 6. Cut the 1.0.1 patch version

- Bump `package.json` `version` from `1.0.0` to `1.0.1`. This is required because `templates/` ships inside the published tarball (`package.json:files`), so consumers who installed `1.0.0` have the broken 404-ing workflow and only a republish reaches them.
- Add a `## [1.0.1] - 2026-09-08` section to `CHANGELOG.md` above the `1.0.0` section, with a `### Fixed` list covering: (a) the scaffolded `depaudit-gate.yml` now installing the published scoped package `@paysdoc/depaudit` instead of the non-existent unscoped `depaudit`; and (b) the `configWriter` baseline tests no longer pinning an absolute expiry date.
- Add the matching `[1.0.1]: https://github.com/paysdoc/depaudit/releases/tag/v1.0.1` link definition next to the existing `[1.0.0]` one at the bottom of the file.
- Leave the existing `1.0.0` section untouched — it is already published in the GitHub release body.

### 7. Verify the build output and run the local smoke test

- Run `bun run build`. Confirm `dist/cli.js` exists and is executable (the `postbuild` script chmods it).
- Run `node dist/cli.js --version` and confirm it prints `1.0.1`, and `node dist/cli.js --help` and confirm it exits 0 with usage text. This exercises the same `src/cli.ts:72`–`:73` path the fresh-machine smoke test uses.
- Run a packaging dry run: `npm pack --dry-run`. Confirm the tarball contents include both `dist/` and `templates/depaudit-gate.yml`, and that the packed template contains the scoped install command.

### 8. Smoke-test the published package in a clean environment

- This satisfies AC "Smoke test passes end-to-end on a fresh machine" without needing a second machine: install into a throwaway npm prefix so nothing global is touched.
- Create a temp dir, then run `npm install -g --prefix <tmpdir> @paysdoc/depaudit@1.0.0`, and execute `<tmpdir>/bin/depaudit --version`. Confirm it prints `1.0.0` and exits 0. Also run `<tmpdir>/bin/depaudit --help` and confirm exit 0.
- Record the exact commands and their output — this is the evidence for the AC checkbox.
- Delete the temp prefix afterwards.
- Note in the report that this validates the **currently published** `1.0.0`; the `1.0.1` tarball can only be smoke-tested after the HITL publish in step 10.

### 9. Run the full validation suite

- Execute every command in `Validation Commands` below and confirm each exits 0.
- For the e2e suite: `osv-scanner` must be on `PATH` or 177 scenarios go `Pending` and the run fails locally (this is an environment gap, not a code defect — CI installs the binary at `.github/workflows/ci.yml`). Install `osv-scanner` locally, or accept CI as the authoritative e2e signal and say so explicitly in the report rather than claiming the suite passed.

### 10. Hand the HITL publish steps back to the operator

- The remaining release actions require an npm token that this workflow does not have (`npm whoami` returns `E401`). Do **not** attempt them; list them in the report as operator actions:
  1. `npm publish --access public` for `1.0.1`.
  2. `git tag v1.0.1 && git push --tags`.
  3. `gh release create v1.0.1` with the `1.0.1` changelog section as the body.
  4. Re-run the step-8 smoke test against `@paysdoc/depaudit@1.0.1`.
- Also note for the issue close-out: AC "`depaudit` is installable via `npm install -g depaudit`" is met by the scoped name `@paysdoc/depaudit`, per the deliberate rename in `b5f220e`. The unscoped name is unclaimed on npm; claiming it is a separate decision and out of scope here.

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `bun install` — restore dependencies from `bun.lock`.
- `bun run typecheck` — TypeScript type check with no emit; must report zero errors.
- `bun run build` — compile to `dist/`; must exit 0 and produce an executable `dist/cli.js`.
- `bun run test` — Vitest unit + integration suite. Must report **0 failed**, i.e. all 355 tests passing (up from `2 failed | 353 passed`). Note: `.adw/commands.md` lists `bun test` for this, but that invokes Bun's own runner rather than the `vitest run` script; `.github/workflows/ci.yml` uses `bun run test`, so use that.
- `bun run test:e2e` — Cucumber e2e suite; requires `osv-scanner` on `PATH`. Must report 0 failed and 0 pending scenarios.
- `node dist/cli.js --version` — must print `1.0.1` and exit 0.
- `npm pack --dry-run` — must list `dist/` and `templates/depaudit-gate.yml` in the tarball contents.

## Notes

- `.adw/coding_guidelines.md` does **not** exist in this repo, and neither does the `guidelines/coding_guidelines.md` fallback. There is no guidelines file to adhere to; follow the conventions already visible in the surrounding code instead — in particular, mirror `src/modules/__tests__/linter.test.ts` for date handling in tests.
- The root cause of defect 1 is a general pattern worth avoiding: any test that writes an expiry date and then asserts the linter finds no errors must derive that date relative to "now". Absolute future dates in this codebase are guaranteed to rot, because expiry enforcement is the product's core behaviour.
- The `CHANGELOG.md` 1.0.0 entries reference `#15`–`#26`, which are the merged **PR** numbers, not the issue numbers `#3`–`#13`. GitHub resolves both, and the text is already published in the release body, so leave it as is.
- `git tag v1.0.0` already exists both locally and on `origin` (`refs/tags/v1.0.0` → `b5f220e`). Do not re-tag or force-push it.
- The last fully green CI run was `24962587724` on 2026-04-26; the two runs after the ADW framework upgrade (`34230773409`, `34230781430`) both failed at the "Unit tests" step, so the e2e step has not run since April. Expect to fix e2e fallout only if it appears — the failures observed locally were all `osv-scanner not found`.
- The `Install depaudit` step in `templates/depaudit-gate.yml` is unpinned (`npm install -g @paysdoc/depaudit` pulls `latest`). That is the existing, intentional design per the issue-10 plan notes; do not pin a version as part of this chore.
