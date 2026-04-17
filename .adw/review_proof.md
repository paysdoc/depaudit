# Review Proof Requirements

This file defines the proof requirements for the `/review` command. The `/review` command reads this file to determine what evidence must be produced before a PR can be approved.

## Proof Type

**Project type: CLI / automation tool (no UI)**

Evidence required for each review:

1. Run `bun run typecheck` and capture output — must show zero type errors
2. Run `bun run lint` and capture output — must show zero lint errors
3. Run `bun test` and capture output — must show all tests passing with coverage summary
4. Confirm the code diff matches the PR description — no undeclared changes
5. For changes to `OsvScannerAdapter` or `SocketApiClient`: confirm mock boundary tests cover the new behavior
6. For changes to `Linter`, `FindingMatcher`, or `ConfigLoader`: confirm fixture-driven unit tests cover all new rules or branches
7. For changes to reporter output (`MarkdownReporter`, `JsonReporter`): confirm snapshot assertions are updated and match the intended output

## Proof Format

Structure proof in the review JSON output as follows:

- `reviewSummary` — one-paragraph overview of what was changed and whether all checks passed
- `reviewIssues` — list of any discrepancies between the PR description and actual changes, or any failing checks
- `screenshots` — not applicable for this project; omit or leave empty

## Proof Attachment

Proof is attached to the PR via review JSON fields:

- `reviewSummary`: narrative overview of the review and check results
- `reviewIssues`: list of issues found (empty list if none)
- `screenshots`: omit (CLI project — no browser screenshots)

## What NOT to Do

- Do NOT take browser screenshots — this is a CLI tool with no web UI
- Do NOT start a dev server — there is none
- Do NOT skip type check or lint — these are the primary verification signals for a CLI project
- Do NOT approve if any test is failing, even if marked as skipped — investigate skips
- Do NOT approve if snapshot assertions were deleted rather than updated to match new output
