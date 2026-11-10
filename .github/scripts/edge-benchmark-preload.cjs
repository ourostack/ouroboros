// Loaded with `node --require` into every process the edge benchmark starts.
// It appends JSON snapshots (memory, module count, modules per package) to the
// file named by EDGE_BENCH_OUT: one at each EDGE_BENCH_SNAP_AT second mark and
// one on exit. Child processes inherit it through NODE_OPTIONS.
const fs = require("fs")

const out = process.env.EDGE_BENCH_OUT
if (out) {
  const started = Date.now()
  const role = process.argv[1] ? require("path").basename(process.argv[1]) : "node"

  const packageOf = (file) => {
    const index = file.lastIndexOf("node_modules/")
    if (index < 0) return "(own)"
    const parts = file.slice(index + "node_modules/".length).split("/")
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
  }

  const snapshot = (when) => {
    const memory = process.memoryUsage()
    const files = Object.keys(require.cache)
    const byPackage = {}
    for (const file of files) {
      const name = packageOf(file)
      byPackage[name] = (byPackage[name] || 0) + 1
    }
    const record = {
      when,
      role,
      pid: process.pid,
      ppid: process.ppid,
      ms: Date.now() - started,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      maxRssKb: process.resourceUsage().maxRSS,
      modules: files.length,
      byPackage,
    }
    try {
      fs.appendFileSync(out, `${JSON.stringify(record)}\n`)
    } catch {
      // The benchmark may have moved on; a lost snapshot is not worth a crash.
    }
  }

  process.on("exit", () => snapshot("exit"))
  const marks = (process.env.EDGE_BENCH_SNAP_AT || "").split(",").map(Number).filter((n) => n > 0)
  for (const mark of marks) setTimeout(() => snapshot(`t${mark}`), mark * 1000).unref()
}
