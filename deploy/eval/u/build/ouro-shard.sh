# Arm `ouro`, step 1, in batches: one shard of Ouro UI's own tests in the tree ouro-test.sh installed and rewrote
# (/work/ouro), at nice 19 with at most 2 workers, so the host's other services keep their headroom. Same image and
# mounts as ouro-test.sh.   bash ouro-shard.sh <index> <count>
# Writes /work/results/ouro-shard-<index>.json and its log.
set -eu
index=$1; count=$2
cd /work/ouro
npm install --global --silent pnpm@10.2.0
CI=1 nice -n 19 pnpm exec vitest run --shard="$index/$count" --maxWorkers=2 --reporter=dot --reporter=json \
  --outputFile="/work/results/ouro-shard-$index.json" > "/work/results/ouro-shard-$index.log" 2>&1 || true
node -e '
const r = require(process.argv[1])
console.log(JSON.stringify({ shard: process.argv[2], files: r.numTotalTestSuites, tests: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests }))
' "/work/results/ouro-shard-$index.json" "$index/$count"
