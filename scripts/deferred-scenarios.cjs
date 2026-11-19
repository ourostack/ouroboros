#!/usr/bin/env node
// Scenario kit for the OURO_DEFERRED_TOOLS trial; no model calls here. A model (or a person) plays the agent:
//   node scripts/deferred-scenarios.cjs prepare <off|on> <dir> [channel]   writes system.txt and tools.json
//   node scripts/deferred-scenarios.cjs find <dir> "<query>"               runs the real find_tools search,
//                                                                          appends the loaded tools to tools.json
// tools.json is exactly the tool list the first request would carry; `find` mirrors what the harness does between
// steps (loaded tools are appended at the end). Needs `npm run build`.
const fs = require("fs")
const os = require("os")
const path = require("path")

const distRoot = path.join(__dirname, "..", "dist")
const [command, ...rest] = process.argv.slice(2)

async function prepare(mode, dir, channel = "cli") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scenario-"))
  process.env.HOME = home
  process.argv.push("--agent", "measure")
  const bundle = path.join(home, "AgentBundles", "measure.ouro")
  fs.mkdirSync(path.join(bundle, "psyche"), { recursive: true })
  fs.writeFileSync(path.join(bundle, "agent.json"), JSON.stringify({
    version: 2, enabled: true,
    humanFacing: { provider: "anthropic", model: "claude-opus-5-5" },
    agentFacing: { provider: "anthropic", model: "claude-opus-5-5" },
    senses: { cli: { enabled: true }, teams: { enabled: true }, bluebubbles: { enabled: true } },
  }))
  fs.writeFileSync(path.join(bundle, "psyche", "SOUL.md"), "i am measure, a fixed fixture agent.")
  fs.writeFileSync(path.join(bundle, "psyche", "IDENTITY.md"), "i am measure.")
  try {
    const { buildSystem } = require(path.join(distRoot, "mind", "prompt.js"))
    const { getToolsForChannel } = require(path.join(distRoot, "repertoire", "tools.js"))
    const { partitionTools } = require(path.join(distRoot, "repertoire", "deferred-tools.js"))
    const { getChannelCapabilities } = require("@ouro.bot/friends")
    const system = await buildSystem(channel)
    const all = getToolsForChannel(getChannelCapabilities(channel))
    const { active, deferred } = mode === "on" ? partitionTools(all) : { active: all, deferred: [] }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "system.txt"), [system.stable, system.volatile].filter(Boolean).join("\n\n"))
    fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify(active, null, 1))
    fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify(deferred))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function find(dir, query) {
  const { searchDeferredTools, formatFindToolsResult } = require(path.join(distRoot, "repertoire", "deferred-tools.js"))
  const pool = JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8"))
  const tools = JSON.parse(fs.readFileSync(path.join(dir, "tools.json"), "utf8"))
  const matched = searchDeferredTools(pool, query)
  for (const tool of matched) if (!tools.some((t) => t.function.name === tool.function.name)) tools.push(tool)
  fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify(tools, null, 1))
  console.log(formatFindToolsResult(matched))
}

if (command === "prepare") prepare(rest[0], rest[1], rest[2]).catch((error) => { console.error(error); process.exitCode = 1 })
else if (command === "find") find(rest[0], rest[1])
else { console.error("usage: prepare <off|on> <dir> [channel] | find <dir> <query>"); process.exitCode = 2 }
