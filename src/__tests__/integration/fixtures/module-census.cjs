// Preloaded with `node --require` by lean-startup.test.ts. On exit (or on
// SIGTERM, for the daemon) it writes the process's loaded modules, grouped by
// npm package, and its peak RSS to the file named by OURO_CENSUS_OUT.
const fs = require("fs")

const out = process.env.OURO_CENSUS_OUT
if (out) {
  const packageOf = (file) => {
    const index = file.lastIndexOf("node_modules/")
    if (index < 0) return "(own)"
    const parts = file.slice(index + "node_modules/".length).split("/")
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
  }
  const write = () => {
    const files = Object.keys(require.cache)
    const packages = {}
    for (const file of files) packages[packageOf(file)] = (packages[packageOf(file)] || 0) + 1
    fs.writeFileSync(out, JSON.stringify({ modules: files.length, packages, maxRssKb: process.resourceUsage().maxRSS }))
  }
  process.on("exit", write)
  process.on("SIGTERM", () => process.exit(0))
}
