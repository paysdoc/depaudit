## Conditional Documentation

- [README.md](../README.md) — Always include; project overview and status
- [specs/prd/depaudit.md](../specs/prd/depaudit.md) — Include when working on architecture decisions, new features, or understanding module boundaries; contains full design, user stories, implementation decisions, and module contracts
- [app_docs/feature-442uul-cli-skeleton-osv-scan.md](../app_docs/feature-442uul-cli-skeleton-osv-scan.md) — When working with the `depaudit scan` command, `ManifestDiscoverer`, `OsvScannerAdapter`, `Finding` types, or troubleshooting CLI exit codes and severity derivation
- [app_docs/feature-oowire-configloader-linter-cve-ignores.md](../app_docs/feature-oowire-configloader-linter-cve-ignores.md) — When working with `ConfigLoader`, `Linter`, `FindingFilter`, `LintCommand`, `osv-scanner.toml` acceptance entries, or the `depaudit lint` subcommand; when implementing lint rules or scan-time CVE suppression; when troubleshooting lint pre-flight failures, `ConfigParseError` line/col reporting, or `ignoreUntil` expiry logic
