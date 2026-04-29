const fs = require("fs")
const path = require("path")

function copyOutlookUiDist(repoRoot = path.resolve(__dirname, ".."), deps = defaultDeps()) {
  const source = deps.join(repoRoot, "packages", "outlook-ui", "dist")
  const destination = deps.join(repoRoot, "dist", "outlook-ui")

  if (!deps.existsSync(source)) {
    throw new Error(`missing Outlook UI build output: ${source}`)
  }

  deps.rmSync(destination, { recursive: true, force: true })
  deps.mkdirSync(deps.dirname(destination), { recursive: true })
  deps.cpSync(source, destination, { recursive: true })

  return { source, destination }
}

function defaultDeps() {
  return {
    cpSync: fs.cpSync,
    dirname: path.dirname,
    existsSync: fs.existsSync,
    join: path.join,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
  }
}

module.exports = {
  copyOutlookUiDist,
}
