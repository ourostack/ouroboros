# Arm `ouro`, step 1b: every test file that failed in ouro-shard.sh's shards, run again one file at a time in the same
# rewritten tree at nice 19 with one worker, to tell failures of the rewrite from browser timeouts under load. Same
# image and mounts as ouro-test.sh. Writes /work/results/ouro-retest/<n>.json and ouro-retest-summary.json.
set -eu
cd /work/ouro
npm install --global --silent pnpm@10.2.0
mkdir -p /work/results/ouro-retest
node -e '
const fs = require("fs")
const failed = new Set()
for (const name of fs.readdirSync("/work/results").filter((n) => /^ouro-shard-\d+\.json$/.test(n)).sort()) {
  for (const f of require("/work/results/" + name).testResults) if (f.status === "failed") failed.add(f.name.replace("/work/ouro/", ""))
}
fs.writeFileSync("/work/results/ouro-retest/files.txt", [...failed].sort().join("\n") + "\n")
'
n=0
while read -r file; do
  [ -n "$file" ] || continue
  n=$((n + 1))
  CI=1 nice -n 19 pnpm exec vitest run "$file" --no-file-parallelism --maxWorkers=1 --reporter=json \
    --outputFile="/work/results/ouro-retest/$n.json" > "/work/results/ouro-retest/$n.log" 2>&1 || true
  echo "$n $file"
done < /work/results/ouro-retest/files.txt
node -e '
const fs = require("fs")
const dir = "/work/results/ouro-retest"
const files = fs.readFileSync(dir + "/files.txt", "utf8").split("\n").filter(Boolean)
const out = { files: files.length, results: files.map((file, i) => {
  const path = `${dir}/${i + 1}.json`
  if (!fs.existsSync(path)) return { file, ran: false }
  const r = require(path)
  const f = r.testResults[0] || { assertionResults: [], message: "no result" }
  return { file, tests: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests,
    failures: f.assertionResults.filter((a) => a.status === "failed").map((a) => ({ test: a.fullName, message: (a.failureMessages || []).join(" ").slice(0, 400) })),
    fileError: f.status === "failed" && f.assertionResults.length === 0 ? (f.message || "").slice(0, 400) : undefined }
}) }
out.stillFailing = out.results.filter((r) => r.ran === false || r.failed > 0 || r.fileError).map((r) => r.file)
fs.writeFileSync("/work/results/ouro-retest-summary.json", JSON.stringify(out, null, 2) + "\n")
console.log(JSON.stringify({ files: out.files, stillFailing: out.stillFailing.length }))
'
