#!/usr/bin/env node
// Deterministic prompt-size measurement; no model calls. Builds the real system prompt for each channel against a
// fixed throwaway agent bundle and prints estimated tokens (the harness's own chars/4 estimator) per section.
// Usage: npm run build && node scripts/measure-prompt.cjs [--sections] [--tools] [--json] [--deferred]
// --deferred measures the OURO_DEFERRED_TOOLS trial beside the baseline: first-request tool schemas with only the
// core tools and find_tools. Sizes are the registry's OpenAI-format schemas (JSON bytes), not provider wire payloads.
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.join(__dirname, "..")
const distRoot = path.join(repoRoot, "dist")
if (!fs.existsSync(path.join(distRoot, "mind", "prompt.js"))) {
  console.error("dist/ is missing: run `npm run build` first")
  process.exit(1)
}

const bundlesHome = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-measure-"))
process.env.HOME = bundlesHome
process.argv.push("--agent", "measure")
const bundle = path.join(bundlesHome, "AgentBundles", "measure.ouro")
fs.mkdirSync(path.join(bundle, "psyche"), { recursive: true })
fs.writeFileSync(path.join(bundle, "agent.json"), JSON.stringify({
  version: 2,
  enabled: true,
  humanFacing: { provider: "anthropic", model: "claude-opus-5-5" },
  agentFacing: { provider: "anthropic", model: "claude-opus-5-5" },
  senses: { cli: { enabled: true }, teams: { enabled: true }, bluebubbles: { enabled: true } },
}))
fs.writeFileSync(path.join(bundle, "psyche", "SOUL.md"), "i am measure, a fixed fixture agent.")
fs.writeFileSync(path.join(bundle, "psyche", "IDENTITY.md"), "i am measure.")

const tokens = (text) => Math.ceil(text.length / 4)

function sectionsOf(text) {
  const out = []
  let title = "(preamble)"
  let buf = []
  const flush = () => { if (buf.join("\n").trim()) out.push({ title, tokens: tokens(buf.join("\n")) }); buf = [] }
  for (const line of text.split("\n")) {
    const heading = /^(#{1,2}) (.+)$/.exec(line)
    if (heading) { flush(); title = line } else buf.push(line)
  }
  flush()
  return out
}

async function main() {
  const { buildSystem } = require(path.join(distRoot, "mind", "prompt.js"))
  const { getToolsForChannel } = require(path.join(distRoot, "repertoire", "tools.js"))
  const { getChannelCapabilities } = require("@ouro.bot/friends")
  const { partitionTools } = require(path.join(distRoot, "repertoire", "deferred-tools.js"))
  const channels = ["cli", "teams", "bluebubbles", "inner", "mcp"]
  const args = process.argv.slice(2)
  const report = {}
  for (const channel of channels) {
    const system = await buildSystem(channel)
    const text = [system.stable, system.volatile].filter(Boolean).join("\n\n")
    const toolSchemas = tokens(JSON.stringify(getToolsForChannel(getChannelCapabilities(channel))))
    if (args.includes("--tools") && channel === "cli") {
      const perTool = getToolsForChannel(getChannelCapabilities(channel)).map((t) => ({ name: t.function.name, tokens: tokens(JSON.stringify(t)) }))
      console.log("== tool schemas (cli) ==")
      for (const t of perTool.sort((a, b) => b.tokens - a.tokens)) console.log(`${String(t.tokens).padStart(6)}  ${t.name}`)
      console.log()
    }
    const all = getToolsForChannel(getChannelCapabilities(channel))
    const deferredActive = partitionTools(all).active
    const bytes = JSON.stringify(all).length
    const deferredBytes = JSON.stringify(deferredActive).length
    const deferredToolSchemas = tokens(JSON.stringify(deferredActive))
    report[channel] = {
      prompt: tokens(text), toolSchemas, perTurn: tokens(text) + toolSchemas, sections: sectionsOf(text),
      toolCount: all.length, schemaBytes: bytes,
      deferred: { toolCount: deferredActive.length, schemaBytes: deferredBytes, toolSchemas: deferredToolSchemas, perTurn: tokens(text) + deferredToolSchemas },
    }
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log("channel        prompt  tool-schemas  per-turn")
  for (const [channel, r] of Object.entries(report)) {
    console.log(`${channel.padEnd(13)} ${String(r.prompt).padStart(7)} ${String(r.toolSchemas).padStart(13)} ${String(r.perTurn).padStart(9)}`)
  }
  if (args.includes("--deferred")) {
    console.log("\nchannel        tools bytes  | deferred: tools bytes  schema-tokens  per-turn  saved")
    for (const [channel, r] of Object.entries(report)) {
      const d = r.deferred
      console.log(`${channel.padEnd(13)} ${String(r.toolCount).padStart(5)} ${String(r.schemaBytes).padStart(6)}  | ${String(d.toolCount).padStart(14)} ${String(d.schemaBytes).padStart(6)} ${String(d.toolSchemas).padStart(13)} ${String(d.perTurn).padStart(9)} ${String(r.perTurn - d.perTurn).padStart(6)}`)
    }
  }
  if (args.includes("--sections")) {
    for (const [channel, r] of Object.entries(report)) {
      console.log(`\n== ${channel} ==`)
      for (const s of r.sections.slice().sort((a, b) => b.tokens - a.tokens)) console.log(`${String(s.tokens).padStart(6)}  ${s.title}`)
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(bundlesHome, { recursive: true, force: true }))
