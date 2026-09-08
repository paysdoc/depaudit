import { configDefaults, defineConfig } from "vitest/config";

// ADW sets ADW_UNIT_TEST_REPORT_PATH when it needs a JUnit report to verify
// the unit-test verdict. Locally the variable is unset and only the default
// reporter runs.
const junitPath = process.env.ADW_UNIT_TEST_REPORT_PATH;

export default defineConfig({
  test: {
    // ADW checks out worktrees under .worktrees/; without this exclusion
    // vitest runs every test file in them a second time.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    reporters: junitPath ? ["default", "junit"] : ["default"],
    outputFile: junitPath ? { junit: junitPath } : undefined,
  },
});
