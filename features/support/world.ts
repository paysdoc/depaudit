import { setDefaultTimeout, setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI_PATH = resolve(PROJECT_ROOT, "dist/cli.js");

// `depaudit scan` shells out to `osv-scanner`, which routinely takes 2–4s per
// invocation and can spike past Cucumber's 5s default under load.
setDefaultTimeout(30_000);

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class DepauditWorld extends World {
  result: RunResult | null = null;
  cwd: string = PROJECT_ROOT;
  /** Absolute path of the fixture currently under test */
  fixturePath: string = PROJECT_ROOT;
  /** Files written during this scenario — cleaned up by After hooks in lint_steps.ts */
  writtenFiles: string[] = [];

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(DepauditWorld);
