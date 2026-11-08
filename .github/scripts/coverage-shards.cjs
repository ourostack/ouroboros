// Splits the coverage suite across CI runners and checks the split.
//
// Vitest's own --shard orders files by path hash and cuts equal-count slices,
// which here puts 2x the work on one shard (one file alone takes ~3.5 min).
// The shard config's sequencer calls assignShards instead: longest file first,
// each to the least-loaded shard, using measured per-file seconds from
// coverage-shard-weights.json. Every runner computes the same split from the
// same file list, so each file runs on exactly one shard; the merge job checks
// that with checkShardLists before it trusts the merged coverage.
//
// Refresh the weights from a single-runner coverage job log:
//   node .github/scripts/coverage-shards.cjs weights <job.log> > .github/coverage-shard-weights.json
const fs = require("fs")

// Files the weights file does not know yet (new tests) get the median weight.
function assignShards(files, weights, count) {
  const known = files.map((file) => weights[file]).filter((value) => typeof value === "number").sort((a, b) => a - b)
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)] : 1
  const weightOf = (file) => (typeof weights[file] === "number" ? weights[file] : fallback)
  const order = [...files].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0))
  const shards = Array.from({ length: count }, () => ({ files: [], load: 0 }))
  for (const file of order) {
    let target = shards[0]
    for (const shard of shards) if (shard.load < target.load) target = shard
    target.files.push(file)
    target.load += weightOf(file)
  }
  return shards.map((shard) => ({ files: shard.files.sort(), load: shard.load }))
}

// lists: one { index, count, all, assigned } record per shard, as the sequencer
// wrote them. Returns problems; empty means every file ran on exactly one shard.
function checkShardLists(lists, count) {
  const problems = []
  const indexes = lists.map((list) => list.index).sort((a, b) => a - b)
  const expected = Array.from({ length: count }, (_, i) => i + 1)
  if (indexes.join(",") !== expected.join(",")) problems.push(`expected shards ${expected.join(",")}, got ${indexes.join(",") || "none"}`)
  for (const list of lists) if (list.count !== count) problems.push(`shard ${list.index} ran as ${list.index}/${list.count}, expected /${count}`)
  if (lists.length === 0) return problems
  const all = [...lists[0].all].sort()
  for (const list of lists) {
    if ([...list.all].sort().join("\n") !== all.join("\n")) problems.push(`shard ${list.index} saw a different test file list`)
  }
  const seen = new Map()
  for (const list of lists) {
    for (const file of list.assigned) {
      if (seen.has(file)) problems.push(`${file} ran on shards ${seen.get(file)} and ${list.index}`)
      else seen.set(file, list.index)
    }
  }
  for (const file of all) if (!seen.has(file)) problems.push(`${file} ran on no shard`)
  for (const file of seen.keys()) if (!all.includes(file)) problems.push(`${file} ran but is not in the test file list`)
  return problems
}

// Per-file wall seconds from a coverage job log. The suite runs one file at a
// time (maxWorkers: 1), so the gap between consecutive file result lines is
// that file's wall time, imports and coverage instrumentation included.
function weightsFromLog(text) {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
  const result = /^(\S+?)Z?\s+[✓×↓❯] (src\/\S+\.tsx?) /u
  const weights = {}
  let previous = null
  for (const line of lines) {
    if (previous === null) {
      if (/^\S+\s+RUN\s+v\d/u.test(line) && !line.includes("packages/")) previous = Date.parse(line.slice(0, line.indexOf(" ")))
      continue
    }
    const match = result.exec(line)
    if (!match || match[2] in weights) continue
    const at = Date.parse(match[1].endsWith("Z") ? match[1] : `${match[1]}Z`)
    weights[match[2]] = Math.round((at - previous) / 100) / 10
    previous = at
  }
  return Object.fromEntries(Object.entries(weights).sort(([a], [b]) => (a < b ? -1 : 1)))
}

if (require.main === module) {
  const [command, file] = process.argv.slice(2)
  if (command !== "weights" || !file) {
    console.error("usage: coverage-shards.cjs weights <job.log>")
    process.exit(2)
  }
  process.stdout.write(`${JSON.stringify(weightsFromLog(fs.readFileSync(file, "utf8")), null, 1)}\n`)
}

module.exports = { assignShards, checkShardLists, weightsFromLog }
