# Arm `ouro`, step 1c: the test files that still failed one at a time after the rewrite (ouro-retest-summary.json),
# run one at a time on the same pin without the rewrite, at nice 19 with one worker, to tell what the rewrite broke
# from what fails here anyway. Same image and mounts as ouro-test.sh.
# Writes /work/results/ouro-baseline/<n>.json and ouro-baseline-summary.json; the unrewritten tree stays at /work/ouro-base.
set -eu
rm -rf /work/ouro-base /work/results/ouro-baseline
mkdir -p /work/ouro-base /work/results/ouro-baseline
tar -xf /in/ouro-ui.tar -C /work/ouro-base
cd /work/ouro-base
npm install --global --silent pnpm@10.2.0
CI=1 pnpm install --frozen-lockfile --reporter=silent
# The failing files are named as the rewrite left them; ouro-rewrite.json's renames ([original path, new name], every
# path the original one) map each back to its name in the unrewritten tree, one path component at a time.
node -e '
const path = require("path")
const back = new Map(require("/work/results/ouro-rewrite.json").renamed.map(([from, to]) => [path.posix.join(path.posix.dirname(from), to), from]))
const original = (file) => file.split("/").reduce((at, part) => { const next = at ? `${at}/${part}` : part; return back.get(next) ?? next }, "")
console.log(require("/work/results/ouro-retest-summary.json").stillFailing.map(original).join("\n"))
' > /work/results/ouro-baseline/files.txt
n=0
while read -r file; do
  [ -n "$file" ] || continue
  n=$((n + 1))
  CI=1 nice -n 19 pnpm exec vitest run "$file" --no-file-parallelism --maxWorkers=1 --reporter=json \
    --outputFile="/work/results/ouro-baseline/$n.json" > "/work/results/ouro-baseline/$n.log" 2>&1 || true
  echo "$n $file"
done < /work/results/ouro-baseline/files.txt
node -e '
const fs = require("fs")
const dir = "/work/results/ouro-baseline"
const files = fs.readFileSync(dir + "/files.txt", "utf8").split("\n").filter(Boolean)
const results = files.map((file, i) => {
  const at = `${dir}/${i + 1}.json`
  if (!fs.existsSync(at)) return { file, ran: false }
  const r = require(at)
  const f = r.testResults[0] || { assertionResults: [], message: "no result" }
  return { file, tests: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests,
    failing: f.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName),
    fileError: f.status === "failed" && f.assertionResults.length === 0 ? (f.message || "").slice(0, 400) : undefined }
})
const out = { files: files.length, results, failingWithoutRewrite: results.filter((r) => r.ran === false || r.failed > 0 || r.fileError).map((r) => r.file) }
fs.writeFileSync("/work/results/ouro-baseline-summary.json", JSON.stringify(out, null, 2) + "\n")
console.log(JSON.stringify({ files: out.files, failingWithoutRewrite: out.failingWithoutRewrite.length }))
'
