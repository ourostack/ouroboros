#!/usr/bin/env node
// Tool-definition tokens per model request, by agent shape and provider path. No model calls, no real agent data:
// the tool lists come from the harness's own selection code on a throwaway fixture bundle, and the Butler's from its
// packaged profiles (deploy/unraid/sanctuary.ouro) plus its media MCP server's tools/list, started with no credentials.
// Each list goes through the provider path's own converter before counting.
//
// Usage: npm run build && node scripts/measure-tool-tokens.cjs [--json]
// Tokens are counted with o200k_base when js-tiktoken can be loaded (exact for GPT models' JSON; an estimate for
// Claude), otherwise with the harness's chars/4 estimate. The header says which. To get o200k without adding a
// dependency: npm i --prefix /tmp/tok js-tiktoken@1.0.21 && NODE_PATH=/tmp/tok/node_modules node scripts/...
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

const repoRoot = path.join(__dirname, "..")
const distRoot = path.join(repoRoot, "dist")
if (!fs.existsSync(path.join(distRoot, "repertoire", "tools.js"))) {
  console.error("dist/ is missing: run `npm run build` first")
  process.exit(1)
}

function tokenCounter() {
  try {
    const { getEncoding } = require("js-tiktoken")
    const encoding = getEncoding("o200k_base")
    return { name: "o200k_base", count: (text) => encoding.encode(text).length }
  } catch {
    return { name: "chars/4 estimate", count: (text) => Math.ceil(text.length / 4) }
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-tool-tokens-"))
process.env.HOME = home
process.argv.push("--agent", "measure")
const bundle = path.join(home, "AgentBundles", "measure.ouro")
fs.mkdirSync(path.join(bundle, "psyche"), { recursive: true })
fs.writeFileSync(path.join(bundle, "agent.json"), JSON.stringify({
  version: 2, enabled: true,
  humanFacing: { provider: "anthropic", model: "claude-opus-5-5" }, agentFacing: { provider: "anthropic", model: "claude-opus-5-5" },
  senses: { cli: { enabled: true }, teams: { enabled: true }, bluebubbles: { enabled: true } },
}))
fs.writeFileSync(path.join(bundle, "psyche", "SOUL.md"), "i am measure, a fixed fixture agent.")

function mcpToolsList(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, SANCTUARY_MEDIA_CREDENTIALS: path.join(home, "none.json") } })
    let buffered = ""
    const timer = setTimeout(() => { child.kill(); reject(new Error("media MCP tools/list timed out")) }, 20000)
    child.stdout.on("data", (chunk) => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop()
      for (const line of lines) {
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 2) { clearTimeout(timer); child.kill(); resolve(message.result.tools) }
      }
    })
    child.on("error", reject)
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "measure", version: "0" } } })
    send({ method: "notifications/initialized" })
    send({ id: 2, method: "tools/list" })
  })
}

async function main() {
  const { selectToolsForChannel, toolSelectionSchemas } = require(path.join(distRoot, "repertoire", "tools.js"))
  const { toAnthropicTools } = require(path.join(distRoot, "heart", "providers", "anthropic.js"))
  const { toResponsesTools } = require(path.join(distRoot, "heart", "streaming.js"))
  const { getChannelCapabilities } = require("@ouro.bot/friends")
  const { buildToolCatalog, partitionCatalog } = require(path.join(distRoot, "repertoire", "tool-catalog.js"))
  const counter = tokenCounter()
  const butlerRoot = path.join(repoRoot, "deploy", "unraid", "sanctuary.ouro")
  const profiles = JSON.parse(fs.readFileSync(path.join(butlerRoot, "tool-profiles.json"), "utf8")).profiles
  const media = await mcpToolsList(path.join(butlerRoot, "mcp", "media-mcp.mjs"))
  const mcpView = { manager: {}, owner: { agentName: "sanctuary", agentRoot: bundle }, entries: [{ server: "media", tools: media, source: "agent", configDigest: "measure", generation: 1 }] }
  // Each shape is what a turn starts with: every selected door ("before"), and the eager doors plus find_tools that the
  // catalog loads up front ("after"). Anthropic still sends the held-back doors, but marked defer_loading, so they
  // stay out of the model's context until find_tools loads them.
  const select = (channel, context, view) => {
    const selection = selectToolsForChannel(getChannelCapabilities(channel), undefined, undefined, new Set(), view, undefined, { agentRoot: bundle, ...context })
    const tools = toolSelectionSchemas(selection)
    const definitions = new Map(selection.ordinary.map((definition) => [definition.tool.function.name, definition]))
    const catalog = buildToolCatalog(tools.map((tool) => ({ tool, ax: definitions.get(tool.function.name)?.ax, mcpServer: definitions.get(tool.function.name)?.mcpServer })))
    return { tools, loaded: partitionCatalog(tools, catalog, [], new Set()).active }
  }
  const butlerProfile = (profileId) => ({ agentName: "sanctuary", relationshipAuthorization: { profileId, advertisedToolNames: profiles[profileId].toolNames } })

  const shapes = {
    "default agent, cli": select("cli", { agentName: "measure" }),
    "default agent, teams": select("teams", { agentName: "measure" }),
    "default agent, inner": select("inner", { agentName: "measure" }),
    "Butler owner, telegram": select("telegram", butlerProfile("sanctuary-owner"), mcpView),
    "Butler household, telegram": select("telegram", butlerProfile("sanctuary-household"), mcpView),
    "Butler, inner": select("inner", { agentName: "sanctuary" }, mcpView),
  }
  const paths = {
    anthropic: (tools) => toAnthropicTools(tools),
    "chat-completions": (tools) => tools,
    responses: (tools) => toResponsesTools(tools),
  }
  const report = { counter: counter.name, shapes: {} }
  const count = (tools) => Object.fromEntries(Object.entries(paths).map(([name, wire]) => [name, counter.count(JSON.stringify(wire(tools)))]))
  for (const [shape, { tools, loaded }] of Object.entries(shapes)) {
    report.shapes[shape] = { tools: tools.length, tokens: count(tools), loaded: loaded.length, loadedTokens: count(loaded) }
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`tool-definition tokens per request (${counter.name}); anthropic = Messages API, chat-completions = Copilot Claude/MiniMax/openai-compatible, responses = Copilot GPT/openai-codex`)
  console.log(`${"shape".padEnd(28)} ${"tools".padStart(9)}  ${"anthropic".padStart(13)}  ${"chat-completions".padStart(16)}  ${"responses".padStart(13)}   (every door -> loaded up front)`)
  const cell = (before, after, width) => `${before} -> ${after}`.padStart(width)
  for (const [shape, row] of Object.entries(report.shapes)) {
    console.log(`${shape.padEnd(28)} ${cell(row.tools, row.loaded, 9)}  ${cell(row.tokens.anthropic, row.loadedTokens.anthropic, 13)}  ${cell(row.tokens["chat-completions"], row.loadedTokens["chat-completions"], 16)}  ${cell(row.tokens.responses, row.loadedTokens.responses, 13)}`)
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(home, { recursive: true, force: true }))
