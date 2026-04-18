import { setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI_PATH = resolve(PROJECT_ROOT, "dist/cli.js");

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

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(DepauditWorld);
