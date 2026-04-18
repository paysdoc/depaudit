# Ubiquitous Language

## Core concepts

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Finding** | A single identified risk — either a CVE or a supply-chain signal — for a specific `(package, version, finding-ID)` tuple | vulnerability, issue, alert |
| **Acceptance** | A deliberate, time-bounded decision to tolerate a known Finding, requiring a written reason and an expiry ≤ 90 days | suppression, ignore, exclusion |
| **Acceptance Register** | The set of all active Acceptance entries across `osv-scanner.toml` and `.depaudit.yml` | allowlist, whitelist (except for `commonAndFine`) |
| **Expiry** | The date on which an Acceptance or Common-and-Fine entry ceases to be valid | expiration, deadline |
| **Baseline** | The set of Acceptances auto-written by `depaudit setup` for all findings present at install time, each with `reason: "baselined at install"` | initial scan, seed |
| **Orphaned entry** | An Acceptance whose `(package, version, finding-ID)` tuple no longer appears in the current scan results | stale entry, dangling accept |
| **Gate** | The CI check that passes or fails a PR based on whether any un-accepted or expired-accepted Findings exist above the configured severity threshold | gate check, audit check |
| **Severity threshold** | The minimum finding severity (`medium`, `high`, or `critical`) at which the Gate fails; configurable per repo, defaulting to `medium` | severity level, threshold |

## Finding sources

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **CVE finding** | A Finding sourced from OSV.dev via OSV-Scanner; identified by a CVE-ID or GHSA-ID | OSV finding |
| **Supply-chain finding** | A Finding sourced from Socket.dev REST API; identified by a Socket alert-type identifier | Socket finding |
| **Common-and-fine entry** | A category-wide whitelist entry for a `(package, alertType)` pair that is expected and non-threatening, with a 365-day max expiry | global whitelist, permanent ignore |
| **Finding identity** | The strict `(package, version, finding-ID)` triple that uniquely identifies a Finding; a version bump invalidates any existing Acceptance | finding key, finding tuple |

## Config artifacts (per target repo)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **`osv-scanner.toml`** | OSV-Scanner's native config file; owns CVE Acceptance entries via `[[IgnoredVulns]]` | CVE config |
| **`.depaudit.yml`** | depaudit's master config; owns policy, `commonAndFine`, and `supplyChainAccepts` | depaudit config |
| **`.depaudit/findings.json`** | Gitignored snapshot of the most recent scan's classified Findings; consumed by `/depaudit-triage` | findings file |
| **Trigger branch** | The production branch the Gate CI workflow is pinned to; `main` if present, else the repo's default branch | production branch, main branch |

## Commands and modules

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **`ScanCommand`** | The composition root that wires the full scan pipeline: discover → lint → OSV → Socket → classify → report | scan runner, audit runner |
| **`DepauditSetupCommand`** | The composition root that bootstraps a target repo: scaffold config, baseline, commit or open PR | setup runner |
| **`ManifestDiscoverer`** | Deep module that walks a repo and returns `(ecosystem, manifest path)` tuples | file walker, manifest finder |
| **`ConfigLoader`** | Deep module that parses and validates `.depaudit.yml` and `osv-scanner.toml` | config parser |
| **`Linter`** | Pure function from parsed configs to a list of lint errors; enforces all schema and policy rules | validator |
| **`FindingMatcher`** | Pure function that classifies each Finding against the Acceptance Register into `new`, `accepted`, `whitelisted`, `expired-accept` | classifier, matcher |
| **`OsvScannerAdapter`** | Deep module that shells out to the `osv-scanner` binary and normalizes output to the internal `Finding` type | OSV adapter |
| **`SocketApiClient`** | Deep module that calls Socket.dev REST API with retry, fail-open on error, and normalizes to `Finding` | Socket client |
| **`StateTracker`** | Deep module that tracks PR-level state for comment deduplication and first-failure Slack notification | state manager |
| **`CommitOrPrExecutor`** | Deep module that encapsulates the "commit directly unless on the production branch, then open a PR" policy | commit handler |
| **`Reporter`** | Composite module composing `MarkdownReporter`, `JsonReporter`, and `SlackReporter` | output formatter |

## Remediation actions

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Minor/patch upgrade** | An upgrade of a direct parent dependency that stays within the same major version; applied autonomously by the triage skill | safe upgrade |
| **Major upgrade** | An upgrade of a direct parent that crosses a major version boundary; never applied autonomously — triggers an issue filed on the current repo | breaking upgrade |
| **Accept with reason** | Adding an Acceptance entry to the register with a written justification and bounded expiry | suppress, silence |
| **Upstream issue** | A GitHub issue filed on the dependency's own repository when the fix must come from the dependency's maintainers; URL recorded in the Acceptance entry | bug report (avoid — too generic) |
| **Fail open** | Socket.dev's failure mode: on API error, supply-chain findings are skipped for the run and the Gate continues on CVE findings alone | graceful degradation |

## Relationships

- A **Finding** belongs to exactly one **Finding source** (OSV or Socket).
- A **Finding** may be matched by at most one **Acceptance** in the **Acceptance Register** (strict identity match).
- An **Acceptance** becomes **Orphaned** when its **Finding** no longer appears in scan results.
- A **Baseline** is a set of **Acceptances** created in bulk by **`DepauditSetupCommand`** at install time.
- A **Common-and-fine entry** matches by `(package, alertType)` only — it applies across all versions, unlike a per-version **Acceptance**.
- The **Gate** reads the **Acceptance Register** from both `osv-scanner.toml` (CVE Acceptances) and `.depaudit.yml` (supply-chain Acceptances and Common-and-fine entries).

## Example dialogue

> **Dev:** "The Gate is failing on PR #42. What does that mean exactly?"
> **Domain expert:** "A **Finding** came back from either OSV or Socket that's above your **severity threshold** and has no matching **Acceptance** in the **Acceptance Register** — or it does have one but it's past its **Expiry**."
> **Dev:** "Can I just add an **Acceptance** and be done with it?"
> **Domain expert:** "Yes — add an entry to the right config file with a `reason` of at least 20 characters and an `expires` no more than 90 days out. The **Linter** will reject it otherwise."
> **Dev:** "What if the dep just released a patch? Can I upgrade instead?"
> **Domain expert:** "If it's a minor or patch bump, run `/depaudit-triage` and it'll apply the upgrade autonomously. If the only fix path is a **Major upgrade**, the skill won't touch the manifest — it files a tracked issue on the current repo and writes a short-lived **Acceptance** so the **Gate** doesn't block unrelated PRs while the upgrade work is in flight."
> **Dev:** "And the old **Acceptance** for a package we've already upgraded — does that linger?"
> **Domain expert:** "Once the **Finding** disappears from the scan, that entry becomes **Orphaned**. `depaudit scan` will auto-prune it from whichever file owns it, unless the **Finding source** was unavailable during that run — in which case it's left untouched to avoid silently discarding a live **Acceptance**."

## Flagged ambiguities

- "whitelist" appears in the PRD for both the `commonAndFine` category rules and general acceptance — canonical split: **Common-and-fine entry** for category-wide rules; **Acceptance** for per-`(package, version, finding-ID)` entries. Avoid "whitelist" except when explicitly referencing `commonAndFine`.
- "ignore" / "suppress" are used informally for both OSV `IgnoredVulns` entries and depaudit supply-chain accepts — canonical term for both is **Acceptance**.
- "production branch" vs "main branch" vs "trigger branch" — canonical term is **Trigger branch** (it may not be `main`; it's resolved at setup time).
