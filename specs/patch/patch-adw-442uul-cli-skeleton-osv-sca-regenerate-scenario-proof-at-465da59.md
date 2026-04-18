# Patch: Regenerate stale `scenario_proof.md` against HEAD (465da59)

## Metadata
adwId: `442uul-cli-skeleton-osv-sca`
reviewChangeRequest: `Issue #1: The supplied scenario proof at /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md reports ## @regression Scenarios as FAILED with exit code 1 and (no output). Per the review protocol, a failed @regression run is a blocker. Resolution: Regenerate the scenario proof on the current branch — the scenario-fix (e8a69a2), e2e-runner-update (1f75f2a), and node_modules untrack (465da59) commits landed after the proof was generated, and a fresh bun run test:e2e -- --tags @regression now shows 7/7 passing. After regeneration, re-run /review with the refreshed proof.`

## Issue Summary
**Original Spec:** `specs/issue-3-adw-442uul-cli-skeleton-osv-sca-sdlc_planner-cli-skeleton-osv-scan.md`

**Issue:** The proof artifact at `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` (timestamped `2026-04-18T10:30:51.786Z`) predates three HEAD-landed commits that together fix the e2e harness:
- `e8a69a2` — scenario-fix: exclude test files from tsconfig compilation
- `1f75f2a` — e2e-runner-update: scenarios.md runner switched to bun
- `465da59` — node_modules untrack

The stale proof records `## @regression Scenarios` and `## @adw-3 Scenarios` as `❌ FAILED` with `(no output)` and exit code `1`. Per `.adw/review_proof.md` and the `/review` protocol, a FAILED blocker-tag run halts approval. Re-running the documented commands against HEAD (`465da59`) produces clean passes — the reviewer reports `bun run test:e2e -- --tags @regression` now shows 7/7 passing. The underlying code is healthy; only the log artifact is stale.

**Solution:** Overwrite the external proof file with fresh stdout captured from HEAD. No repo source, config, or test changes — this is a pure artifact refresh, mirroring the approach in the earlier `patch-adw-442uul-cli-skeleton-osv-sca-regenerate-stale-scenario-proof.md` patch. The regenerated file must match the exact shape produced by `adws/phases/scenarioProof.ts#buildProofMarkdown` so the review parser continues to match.

## Files to Modify
Use these files to implement the patch:

- `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — stale external proof artifact to overwrite with fresh passing output (not under the repo; no git diff).

## Implementation Steps
IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Confirm worktree HEAD and dependencies
- Verify `git rev-parse HEAD` reports `465da59...` so the captured proof will match the commit the reviewer audited.
- Run `bun install` from the worktree root to ensure `@cucumber/cucumber` and related e2e deps are resolved.

### Step 2: Capture fresh stdout for both blocker tags
- Execute `bun run test:e2e -- --tags "@regression"` and capture combined stdout. Expect exit `0` and a summary matching `7 scenarios (7 passed)` / `46 steps (46 passed)` (per reviewer's fresh run).
- Execute `bun run test:e2e -- --tags "@adw-3"` and capture combined stdout. Expect exit `0` and a summary matching `8 scenarios (8 passed)` / `51 steps (51 passed)`.
- If either command exits non-zero, STOP. Capture the full stderr/stdout into the new proof so the failure cause is visible (not `(no output)`), then escalate to a source-level fix patch — do NOT overwrite with a fake PASSED proof.

### Step 3: Overwrite the stale proof artifact
- Write the absolute file `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` with the exact markdown shape emitted by `adws/phases/scenarioProof.ts#buildProofMarkdown`:
  - Top: `# Scenario Proof`, blank line, `Generated at: <new ISO-8601 timestamp>`, blank line.
  - Section for `@regression`: `## @regression Scenarios (severity: blocker)` / blank / `**Status:** ✅ PASSED` / `**Exit Code:** 0` / blank / `### Output` / blank / fenced triple-backtick block containing the Step-2 `@regression` stdout / blank.
  - Section for `@adw-3`: `## @adw-3 Scenarios (severity: blocker)` / blank / `**Status:** ✅ PASSED` / `**Exit Code:** 0` / blank / `### Output` / blank / fenced triple-backtick block containing the Step-2 `@adw-3` stdout / blank.
- Preserve the exact emoji status labels (`✅ PASSED`) and field names (`**Status:**`, `**Exit Code:**`, `### Output`) from the existing parser contract.

## Validation
Execute every command to validate the patch is complete with zero regressions.

- `bun run test:e2e -- --tags "@regression"` — must exit 0 and print `7 scenarios (7 passed)` / `46 steps (46 passed)`.
- `bun run test:e2e -- --tags "@adw-3"` — must exit 0 and print `8 scenarios (8 passed)` / `51 steps (51 passed)`.
- `grep -c "✅ PASSED" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — must return `2` (one per blocker tag).
- `grep -c "❌ FAILED" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — must return `0`.
- `grep -c "(no output)" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md` — must return `0`.
- `grep -E "^\*\*Exit Code:\*\* 0$" /Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md | wc -l` — must return `2`.
- `bun run typecheck` — must exit 0 (confirms no incidental repo regressions; the patch does not touch repo source).
- `bun test` — must pass (defensive regression check per `.adw/review_proof.md`).

## Patch Scope
**Lines of code to change:** 0 repo-source lines. One full overwrite of an external ~30-line markdown artifact at `/Users/martin/projects/paysdoc/AI_Dev_Workflow/agents/442uul-cli-skeleton-osv-sca/scenario-test/scenario_proof.md`.
**Risk level:** low — log artifact only; no runtime, build, or test behavior changes.
**Testing required:** Re-execute both blocker-tag suites via `bun run test:e2e` to produce fresh stdout, then confirm the regenerated proof parses as two `✅ PASSED` blocker sections with exit code `0`.
