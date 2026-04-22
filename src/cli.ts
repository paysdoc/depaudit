#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { runScanCommand } from "./commands/scanCommand.js";
import { runLintCommand } from "./commands/lintCommand.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `
Usage: depaudit <command> [options]

Commands:
  setup [path]           Bootstrap a target repo: scaffold config, baseline findings, and commit (default path: cwd)
  scan [path]            Scan a Node repository for CVE findings (default path: cwd)
  lint [path]            Lint osv-scanner.toml (default path: cwd)
  post-pr-comment        Post or update a depaudit gate comment on a PR

Options:
  -h, --help             Print this help message and exit
  -v, --version          Print the version and exit
  -f, --format           Output format for stdout (markdown|text; default: markdown)
      --body-file        Path to the markdown body (post-pr-comment)
      --pr               PR number (post-pr-comment; defaults to pull_request event)
      --repo             GitHub repo as owner/name (post-pr-comment; defaults to GITHUB_REPOSITORY)
`.trimStart();

async function main(): Promise<void> {
  let values: {
    help?: boolean;
    version?: boolean;
    format?: string;
    "body-file"?: string;
    pr?: string;
    repo?: string;
  };
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        format: { type: "string", short: "f" },
        "body-file": { type: "string" },
        pr: { type: "string" },
        repo: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as {
      help?: boolean;
      version?: boolean;
      format?: string;
      "body-file"?: string;
      pr?: string;
      repo?: string;
    };
    positionals = parsed.positionals;
  } catch (err: unknown) {
    process.stderr.write(`error: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }

  const [subcommand, cmdPath, ...extra] = positionals;

  if (extra.length > 0) {
    process.stderr.write(`error: unexpected arguments: ${extra.join(" ")}\n\n${USAGE}`);
    process.exit(2);
  }

  if (subcommand === "scan") {
    const format = values.format ?? "markdown";
    if (format !== "markdown" && format !== "text") {
      process.stderr.write(`error: unknown --format value '${format}' (expected 'markdown' or 'text')\n\n${USAGE}`);
      process.exit(2);
    }
    try {
      const result = await runScanCommand(cmdPath ?? process.cwd(), { format });
      process.exit(result.exitCode);
    } catch (err: unknown) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  } else if (subcommand === "lint") {
    try {
      const code = await runLintCommand(cmdPath ?? process.cwd());
      process.exit(code);
    } catch (err: unknown) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  } else if (subcommand === "post-pr-comment") {
    const bodyFile = values["body-file"];
    if (!bodyFile) {
      process.stderr.write(`error: --body-file is required\n\n${USAGE}`);
      process.exit(2);
    }
    let prNumber: number | undefined;
    if (values.pr) {
      const n = Number(values.pr);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        process.stderr.write(
          `error: --pr must be an integer, got '${values.pr}'\n\n${USAGE}`
        );
        process.exit(2);
      }
      prNumber = n;
    }
    try {
      const { runPostPrCommentCommand } = await import(
        "./commands/postPrCommentCommand.js"
      );
      const code = await runPostPrCommentCommand({
        bodyFile,
        repo: values.repo,
        prNumber,
      });
      process.exit(code);
    } catch (err: unknown) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(2);
    }
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
  } else {
    process.stderr.write(subcommand ? `unknown command: ${subcommand}\n\n${USAGE}` : USAGE);
    process.exit(2);
  }
}

main();
