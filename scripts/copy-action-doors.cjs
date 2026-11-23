// Copies the doors ouro-actions generated into dist/, beside the compiled code that reads them
// (src/heart/letters/doors.ts). Every runtime ships dist/: the npm package, the Sanctuary image and the eval sandbox's
// agent image, so the doors go where the code goes and no image has to copy them on its own.
const fs = require("fs")
const path = require("path")

/** The generated files doors.ts reads at run time, relative to actions/generated/. */
const ACTION_DOOR_FILES = [
  "mailbox/actions.json",
  "mailbox/commands.json",
  "mailbox/mcp.json",
  "mailbox-tools/tools.json",
]

/** Where each file ships: dist/actions/generated/<file>. */
const SHIPPED_ACTION_DOOR_PATHS = ACTION_DOOR_FILES.map((file) => `dist/actions/generated/${file}`)

/** Each shipped copy and the generated file it comes from, for package-assets' source-tree check before a build. */
const ACTION_DOOR_SOURCES = Object.fromEntries(ACTION_DOOR_FILES.map((file) => [`dist/actions/generated/${file}`, `actions/generated/${file}`]))

function copyActionDoors(repoRoot) {
  for (const file of ACTION_DOOR_FILES) {
    const from = path.join(repoRoot, "actions", "generated", file)
    const to = path.join(repoRoot, "dist", "actions", "generated", file)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  return ACTION_DOOR_FILES.length
}

if (require.main === module) {
  const count = copyActionDoors(path.resolve(process.argv[2] ?? path.join(__dirname, "..")))
  process.stdout.write(`copied ${count} generated action doors into dist/actions/generated\n`)
}

module.exports = { ACTION_DOOR_FILES, ACTION_DOOR_SOURCES, SHIPPED_ACTION_DOOR_PATHS, copyActionDoors }
