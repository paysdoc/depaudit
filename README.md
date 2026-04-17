# depaudit

Polyglot dependency audit gate. Scans every manifest in a repo for CVEs (via OSV.dev) and supply-chain risk (via Socket.dev), classifies findings against a committed, time-limited acceptance list, and fails CI when new or expired findings exist.

## Status

Pre-release. See [specs/prd/depaudit.md](specs/prd/depaudit.md) for the full design.

Work is tracked in this repo's [Issues](https://github.com/paysdoc/depaudit/issues). Slice numbering comes from the PRD's tracer-bullet breakdown.
