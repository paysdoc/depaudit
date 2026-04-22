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
  scan [path]   Scan a Node repository for CVE findings (default path: cwd)
  lint [path]   Lint osv-scanner.toml (default path: cwd)

Options:
  -h, --help     Print this help message and exit
  -v, --version  Print the version and exit
  -f, --format   Output format for stdout (markdown|text; default: markdown)
`.trimStart();

async function main(): Promise<void> {
  let values: { help?: boolean; version?: boolean; format?: string };
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        format: { type: "string", short: "f" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { help?: boolean; version?: boolean; format?: string };
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
  } else {
    process.stderr.write(subcommand ? `unknown command: ${subcommand}\n\n${USAGE}` : USAGE);
    process.exit(2);
  }
}

main();
