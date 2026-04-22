# MarkdownReporter → stdout + PR-comment-ready markdown

**ADW ID:** xgupjx-markdownreporter-std
**Date:** 2026-04-22
**Specification:** (inline plan in branch feature-issue-9-markdown-reporter-stdout-pr-comments)

## Overview

`depaudit scan` now emits PR-comment-ready markdown to stdout by default. The markdown begins with an HTML marker (`<!-- depaudit-gate-comment -->`), followed by a `PASS`/`FAIL` header, per-category counts (new / accepted / whitelisted / expired), a new-findings table when applicable, an expired-accepts section when applicable, and supply-chain / OSV unavailability annotations. The output is byte-deterministic: identical scan inputs always produce identical markdown.

A `--format text` flag preserves the legacy line-based stdout for users with ad-hoc shell pipelines. JSON output to `.depaudit/findings.json` is format-orthogonal (always written regardless of `--format`).

## What Was Built

- `src/types/markdownReport.ts` — `MARKDOWN_COMMENT_MARKER` constant and `MarkdownReportOptions` interface
- `src/types/finding.ts` — extended `Finding` with optional `fixedVersion?: string`
- `src/modules/markdownReporter.ts` — pure `renderMarkdownReport(result, options?): string`; internal helpers: `bucketByCategory`, `compareForRender`, `escapeCell`, `defaultSuggestedAction`, `renderTable`
- `src/modules/osvScannerAdapter.ts` — `deriveFixedVersion` derives the lowest OSV-published fix strictly greater than the installed version; populates `Finding.fixedVersion`
- `src/modules/__tests__/markdownReporter.test.ts` — 209 unit tests across 8 groups: marker/header, count list, new-findings table, expired-accepts section, annotations, cell escapes, determinism/purity, fixture byte-comparison
- `src/modules/__tests__/fixtures/markdown-output/` — 11 expected-markdown fixture files covering every output shape
- `src/cli.ts` — `--format <markdown|text>` / `-f` flag; default `markdown`; unknown values exit 2
- `src/commands/scanCommand.ts` — format switch; markdown emit after `exitCode` is computed; text mode preserves legacy stdout byte-for-byte
- `features/scan_markdown_reporter.feature` — 28 BDD scenarios tagged `@adw-9`
- `features/step_definitions/scan_markdown_reporter_steps.ts` — markdown table parsing, marker/header/count/annotation assertions, snapshot-reproducibility helpers
- 28 `fixtures/md-*/` directories — one per BDD scenario
- All legacy `features/scan*.feature` files with `FINDING_LINE_RE`-dependent assertions migrated to `--format text`

## Technical Implementation

### Files Modified

- `src/types/finding.ts`: `fixedVersion?: string` added after `summary`
- `src/modules/osvScannerAdapter.ts`: `deriveFixedVersion` helper + `affected[]` walk in the vulnerability loop
- `src/cli.ts`: `format: { type: "string", short: "f" }` in `parseArgs`; format validation; `runScanCommand(path, { format })` call
- `src/commands/scanCommand.ts`: `options: { format }` parameter with default `"markdown"`; format switch replacing unconditional `printFindings`; `renderMarkdownReport` emit after `exitCode`; expired-accept stderr lines suppressed in markdown mode
- `features/scan.feature`, `features/scan_polyglot.feature`, `features/scan_severity_threshold.feature`, `features/scan_socket_supply_chain.feature`: `--format text` appended to `When I run` steps that assert finding lines

### Key Changes

**`renderMarkdownReport` output structure:**
```
\n<!-- depaudit-gate-comment -->\n
\n
## depaudit gate: PASS|FAIL\n
\n
- new: N\n- accepted: N\n- whitelisted: N\n- expired: N\n
[### New findings (N)\n\n| severity | package | version | finding-id | suggested action |\n| --- | ... |\n| ..rows.. |\n]
[### Expired accepts (N)\n\n| severity | package | version | finding-id | suggested action |\n| --- | ... |\n| ..rows.. |\n]
[> supply-chain unavailable — Socket scan failed; CVE-only gating ran for this run.\n]
[> CVE scan unavailable — OSV scanner failed; supply-chain gating ran for this run.\n]
```

**Suggested-action resolution order for `new` rows:**
1. Custom `options.suggestedActionFor` hook if provided
2. `` `upgrade ${package} to >=${fixedVersion}` `` when OSV publishes a fix
3. `"investigate; accept or upgrade"` as plain-text fallback

**For `expired-accept` rows:** always `"re-evaluate or extend acceptance"`.

**`deriveFixedVersion` algorithm:** walks `vuln.affected[].ranges[].events[]`, collects `fixed` values where `package.name` and `package.ecosystem` match, filters to values lexicographically greater than the installed version, returns the lowest qualifying fix.

## How to Use

```sh
# Default — markdown to stdout
depaudit scan

# Explicit markdown
depaudit scan --format markdown

# Legacy line-based stdout
depaudit scan --format text

# Short form
depaudit scan -f text
```

## Configuration

No new configuration files. The `--format` flag is a CLI-only concern. `MarkdownReportOptions.suggestedActionFor` is available for programmatic callers who import `renderMarkdownReport` directly.

## Testing

- Unit tests: `bun test` — 209 tests across `markdownReporter.test.ts` + `osvScannerAdapter.test.ts` extensions
- BDD: `bun run test:e2e -- --tags "@adw-9"` — 28 scenarios
- Regression: `bun run test:e2e -- --tags "@regression"` — 141 scenarios (unchanged pass rate)

## Notes

- **No new runtime dependencies.** Renderer is pure-string composition.
- **Stderr lines preserved in markdown mode.** `socket: supply-chain unavailable`, `osv: CVE scan failed catastrophically`, and `auto-prune:` lines continue on stderr in markdown mode. Per-finding `expired accept:` lines are suppressed (the markdown expired-accepts section subsumes them).
- **HTML marker present on every emission** (pass and fail) so future PR-comment-update logic can locate the prior comment for in-place rewrite.
- **`--format text` migration:** every `@regression` scenario that asserted on finding lines now passes `--format text`; scenarios asserting only on stderr/exit code/file state were left unchanged.
- **Snapshot timing trick limitation:** the expired-only snapshot reproducibility scenario refreshes the `osv-scanner.toml` timing before each capture to work around the linter's past-date rejection.
