# Arm `ouro` (pre-registration section 2), step 1: the kit's own tests after the brand rewrite.
# Runs in mcr.microsoft.com/playwright:v1.65.0-noble (the Playwright its browser tests pin) with:
#   /in/ouro-ui.tar   the kit's tree at 45b39c4a632bf52577a8dd488bc8be97f15bfa81 (git archive)
#   /build            this folder
#   /work             a scratch volume; the rewritten tree stays at /work/ouro for the packaging step
# Writes /work/results/ouro-rewrite.json (the replacement list) and /work/results/ouro-tests.json (Vitest's JSON).
set -eu
mkdir -p /work/results
rm -rf /work/ouro
mkdir -p /work/ouro
tar -xf /in/ouro-ui.tar -C /work/ouro
cd /work/ouro
npm install --global --silent pnpm@10.2.0
# Install from the kit's own lockfile first: the lockfile names third-party packages, which keep their names.
CI=1 pnpm install --frozen-lockfile --reporter=silent
node /build/rewrite.mjs rewrite /work/ouro /work/results/ouro-rewrite.json --keep-package-scopes --skip node_modules,pnpm-lock.yaml
# The repository's `pnpm test` without coverage: its default projects (node and browser), as its CI's unit run.
CI=1 pnpm exec vitest run --reporter=json --outputFile=/work/results/ouro-tests.json --reporter=dot > /work/results/ouro-tests.log 2>&1 || true
node -e '
const r = require("/work/results/ouro-tests.json")
const out = { files: r.numTotalTestSuites, tests: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests, success: r.success,
  failures: r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => ({ file: f.name.replace("/work/ouro/", ""), test: a.fullName }))),
  fileErrors: r.testResults.filter((f) => f.status === "failed" && f.assertionResults.length === 0).map((f) => ({ file: f.name.replace("/work/ouro/", ""), message: (f.message || "").slice(0, 400) })) }
require("fs").writeFileSync("/work/results/ouro-tests-summary.json", JSON.stringify(out, null, 2) + "\n")
console.log(JSON.stringify({ tests: out.tests, passed: out.passed, failed: out.failed, skipped: out.skipped, fileErrors: out.fileErrors.length }))
'
