# Arm `mui` (pre-registration section 2), step 1: the kit's own tests after the brand rewrite.
# Runs in node:22-bookworm with /build (this folder) and /work (a scratch volume). Fetches the kit at
# bae15c1074845419c623c0923449fb4831a26d76, installs it from its own lockfile, rewrites every brand word except the
# workspace's own package names (`@mui/*`, folders `mui-*`), which the packaging step renames, then runs
# @mui/material's own test script (its node and browser projects).
# Writes /work/results/mui-rewrite.json and /work/results/mui-tests*.json; the tree stays at /work/mui.
set -eu
mkdir -p /work/results
rm -rf /work/mui
mkdir -p /work/mui
cd /work/mui
git init -q
git remote add origin https://github.com/mui/material-ui.git
git fetch -q --depth 1 origin bae15c1074845419c623c0923449fb4831a26d76
git checkout -q FETCH_HEAD
npm install --global --silent pnpm@12.21.0
CI=1 pnpm install --frozen-lockfile --reporter=silent
pnpm exec playwright install --with-deps chromium > /work/results/mui-playwright.log 2>&1
node /build/rewrite.mjs rewrite /work/mui /work/results/mui-rewrite.json --keep-package-scopes --skip node_modules,pnpm-lock.yaml,docs
# MUI's own packages installed from npm (its test utilities among them) get the same replacement list, so the kit and
# the tests that check it read the same words (`kitName`, `--kit-` variables).
rm -f /work/results/mui-rewrite-npm.txt
n=0
for dir in node_modules/.pnpm/@mui+*/node_modules/@mui/*; do
  [ -d "$dir" ] && [ ! -L "$dir" ] || continue
  n=$((n + 1))
  node /build/rewrite.mjs rewrite "$dir" "/work/results/mui-rewrite-npm-$n.json" --keep-package-scopes --workspace /work/mui > /dev/null
  echo "$n $dir" >> /work/results/mui-rewrite-npm.txt
done
# packages/mui-material's `test` script is `pnpm --workspace-root test:unit --project "*:@mui/material"`, and the
# root's `test:unit` is `cross-env TZ=UTC vitest`; this is the same run with a JSON report.
CI=1 TZ=UTC nice -n 19 pnpm exec vitest run --project "*:@mui/material" --maxWorkers=2 --reporter=dot --reporter=json --outputFile=/work/results/mui-tests.json > /work/results/mui-tests.log 2>&1 || true
node -e '
const r = require("/work/results/mui-tests.json")
const out = { files: r.numTotalTestSuites, tests: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests, success: r.success,
  failures: r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => ({ file: f.name.replace("/work/mui/", ""), test: a.fullName }))),
  fileErrors: r.testResults.filter((f) => f.status === "failed" && f.assertionResults.length === 0).map((f) => ({ file: f.name.replace("/work/mui/", ""), message: (f.message || "").slice(0, 400) })) }
require("fs").writeFileSync("/work/results/mui-tests-summary.json", JSON.stringify(out, null, 2) + "\n")
console.log(JSON.stringify({ tests: out.tests, passed: out.passed, failed: out.failed, skipped: out.skipped, fileErrors: out.fileErrors.length }))
'
# Step 2: build @mui/material and the workspace packages it depends on with the kit's own build, and pack each as
# it would publish (publishConfig.directory), for the template to install.
CI=1 pnpm --filter "@mui/material..." run build > /work/results/mui-build.log 2>&1
rm -rf /work/pkg/k3
mkdir -p /work/pkg/k3
pnpm --filter "@mui/material..." ls --depth -1 --json > /work/results/mui-packages.json
node -e '
const { execFileSync } = require("child_process")
for (const p of require("/work/results/mui-packages.json")) execFileSync("pnpm", ["pack", "--pack-destination", "/work/pkg/k3"], { cwd: p.path, stdio: "inherit" })
'
ls /work/pkg/k3
