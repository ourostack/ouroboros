# Arm `mui`, step 1c: the test files that failed after the rewrite (mui-tests.json), run on the same pin without the
# rewrite, at nice 19 with 2 workers, to tell what the rewrite broke from what fails here anyway.
# Same image and mounts as mui-test.sh. Writes /work/results/mui-baseline.json and mui-baseline-summary.json;
# the unrewritten tree stays at /work/mui-base.
set -eu
rm -rf /work/mui-base
mkdir -p /work/mui-base
cd /work/mui-base
git init -q
git remote add origin https://github.com/mui/material-ui.git
git fetch -q --depth 1 origin bae15c1074845419c623c0923449fb4831a26d76
git checkout -q FETCH_HEAD
npm install --global --silent pnpm@12.21.0
CI=1 pnpm install --frozen-lockfile --reporter=silent
pnpm exec playwright install --with-deps chromium > /work/results/mui-baseline-playwright.log 2>&1
files=$(node -e '
const r = require("/work/results/mui-tests.json")
console.log([...new Set(r.testResults.filter((f) => f.status === "failed").map((f) => f.name.replace("/work/mui/", "")))].join(" "))
')
# shellcheck disable=SC2086
CI=1 TZ=UTC nice -n 19 pnpm exec vitest run --project "*:@mui/material" --maxWorkers=2 $files --reporter=dot --reporter=json --outputFile=/work/results/mui-baseline.json > /work/results/mui-baseline.log 2>&1 || true
node -e '
const base = require("/work/results/mui-baseline.json")
const after = require("/work/results/mui-tests.json")
const failedIn = (r, root) => r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => `${f.name.replace(root, "")} :: ${a.fullName}`))
const baseFailed = failedIn(base, "/work/mui-base/")
const out = { files: base.numTotalTestSuites, tests: base.numTotalTests, passed: base.numPassedTests, failed: base.numFailedTests,
  failedWithoutRewrite: baseFailed, failedAfterRewrite: failedIn(after, "/work/mui/").length }
require("fs").writeFileSync("/work/results/mui-baseline-summary.json", JSON.stringify(out, null, 2) + "\n")
console.log(JSON.stringify({ files: out.files, tests: out.tests, passed: out.passed, failed: out.failed, failedAfterRewrite: out.failedAfterRewrite }))
'
