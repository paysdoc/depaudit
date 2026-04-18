# Patch: Fix `.adw/scenarios.md` to use the `tsx/esm`-wired runner

## Metadata
adwId: `442uul-cli-skeleton-osv-sca`
reviewChangeRequest: `Issue #1: scenario_proof.md reports @regression Scenarios FAILED (exit 1, no output). Manual execution via 'bun run test:e2e -- --tags @regression' shows 7 scenarios / 46 steps passing, so the failure is a proof-harness invocation issue (likely the runner invoked cucumber-js without the tsx/esm loader, causing world.ts module resolution to fail), not an implementation defect. Regardless, the review-proof strategy treats a FAILED regression block as a blocker. Resolution: Regenerate the scenario proof using the documented command 'bun run test:e2e -- --tags "@regression"' (which wires 'node --import tsx/esm') and re-run /review. If a generator script is producing this proof, fix it to use the test:e2e script rather than a bare cucumber-js invocation.`

## Issue Summary
**Original Spec:** `specs/issue-3-adw-442uul-cli-skeleton-osv-sca-sdlc_planner-cli-skeleton-osv-scan.md`

**Issue:** The review step produced a `scenario_proof.md` reporting the `@regression` block as FAILED (exit 1, no output). The implementation itself is fine — executing the documented `bun run test:e2e -- --tags "@regression"` passes all 7 scenarios / 46 steps cleanly. The FAIL comes from the proof harness reading `.adw/scenarios.md`, whose `## Run Regression Scenarios` entry is a bare `cucumber-js --tags "@regression"`. Invoking cucumber-js directly bypasses the `node --import tsx/esm` loader wired in the `package.json` `test:e2e` script, so the ESM resolver cannot locate `features/support/world.ts` (it searches for `world.js`) and the run explodes with `ERR_MODULE_NOT_FOUND`. Reproduced in this worktree:
- `bun run test:e2e -- --tags "@regression"` → 7 passed, 46 steps passed
- `bunx cucumber-js --tags "@regression"` → `ERR_MODULE_NOT_FOUND: Cannot find module '.../features/support/world.js'`

**Solution:** Align `.adw/scenarios.md` with `.adw/commands.md` so every downstream harness reads the `tsx/esm`-wired `bun run test:e2e -- --tags "@{tag}"` form. No source or test changes needed; the failure is purely in the command documented for the harness.

## Files to Modify
Use these files to implement the patch:

- `.adw/scenarios.md` — swap both `cucumber-js --tags ...` lines for the `bun run test:e2e -- --tags ...` equivalents (matches `.adw/commands.md`).

## Implementation Steps
IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Update `.adw/scenarios.md` to use the wired runner
- Replace `cucumber-js --tags "@{tag}"` under `## Run Scenarios by Tag` with `bun run test:e2e -- --tags "@{tag}"`.
- Replace `cucumber-js --tags "@regression"` under `## Run Regression Scenarios` with `bun run test:e2e -- --tags "@regression"`.
- Leave all other sections (`## Scenario Directory`) untouched.

### Step 2: Regenerate the scenario proof and re-run `/review`
- After committing the `.adw/scenarios.md` fix, regenerate `scenario_proof.md` using the documented command so the review harness captures a green `@regression` block:
  - `bun run test:e2e -- --tags "@regression"`
- Re-invoke `/review` to produce an updated review artifact with the passing proof attached.

## Validation
Execute every command to validate the patch is complete with zero regressions.

- `bun run test:e2e -- --tags "@regression"` — must exit 0 and print `7 scenarios (7 passed)` / `46 steps (46 passed)`.
- `grep -n "bun run test:e2e -- --tags" .adw/scenarios.md` — must report two matching lines (one each for the by-tag and regression sections); no remaining bare `cucumber-js` invocations in the file.
- `diff <(sed -n '/^## Run Scenarios by Tag/,/^## /p' .adw/scenarios.md) <(sed -n '/^## Run Scenarios by Tag/,/^## /p' .adw/commands.md)` — the `Run Scenarios by Tag` section should now match between the two files.

## Patch Scope
**Lines of code to change:** 2 (two single-line edits in `.adw/scenarios.md`)

**Risk level:** low (documentation-only; no runtime or test behavior change)

**Testing required:** Re-run the cucumber regression suite via the corrected command and regenerate `scenario_proof.md`; confirm the 7-scenario green result is captured.
