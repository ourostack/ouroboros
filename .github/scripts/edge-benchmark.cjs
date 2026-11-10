#!/usr/bin/env node
// Edge benchmark: how lean the harness is on the host it runs on.
//
// It installs the packed @ouro.bot/cli the way a user would (or measures a
// built checkout), then measures, per host:
//   install     bytes on disk, files and packages of a production install
//   cli         `ouro --version`: wall time, peak RSS, modules loaded
//   daemon      an agentless daemon: time to its socket, idle RSS, modules
//   stack       a daemon with one agent (fake vault, fake provider), idle
//   turn        one operator message through that stack: time to the first
//               model request, time until the stack goes quiet, peak memory
// Every number is "lower is better". The report compares a run with a
// baseline run (main's latest) and says which numbers moved.
//
//   node .github/scripts/edge-benchmark.cjs run --tarball <tgz> --out result.json
//   node .github/scripts/edge-benchmark.cjs run --root <built checkout> --out result.json
//   node .github/scripts/edge-benchmark.cjs report --current result.json [--baseline base.json] [--summary file]
const fs = require("fs")
const http = require("http")
const os = require("os")
const path = require("path")
const { spawn, spawnSync } = require("child_process")

const PRELOAD = path.join(__dirname, "edge-benchmark-preload.cjs")
const CLI_RUNNER = path.join(__dirname, "edge-benchmark-cli.cjs")
const AGENT = "edgebench"
const VAULT_SERVER_URL = "https://vault.edge-benchmark.test"
const VAULT_EMAIL = "edgebench@ouro.bot"
const VAULT_SECRET = "Benchmark1!"
const MODEL = "claude-sonnet-4.6"
const FAKES = new Set(["bw", "security", "secret-tool"])

// ── pure helpers (unit-tested) ─────────────────────────────────────────────

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command, runs: 5, idleSeconds: 20, turnQuietMs: 3000, turnTimeoutMs: 90_000 }
  const numeric = new Set(["runs", "idleSeconds", "turnQuietMs", "turnTimeoutMs"])
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`)
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const value = rest[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`)
    options[key] = numeric.has(key) ? Number(value) : value
    index += 1
  }
  return options
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** `ps -A -o pid=,ppid=,rss=,args=` output → Map(pid → { ppid, rssKb, args }). */
function parsePsTable(text) {
  const table = new Map()
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line)
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), rssKb: Number(match[3]), args: match[4].trim() })
  }
  return table
}

/** A short name for a process: the script node runs, or the program. */
function processRole(args) {
  const words = String(args || "").split(/\s+/).filter(Boolean)
  const script = words.find((word, index) => index > 0 && /\.(c|m)?js$/.test(word))
  return path.basename(script || words[0] || "?")
}

/** Every pid in the tree rooted at `root`, the root first. */
function treePids(table, root) {
  if (!table.has(root)) return []
  const children = new Map()
  for (const [pid, row] of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid).push(pid)
  }
  const pids = []
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift()
    pids.push(pid)
    queue.push(...(children.get(pid) || []))
  }
  return pids
}

/** `/proc/<pid>/smaps_rollup` or `/proc/<pid>/status` text → the kB value of `field`. */
function procField(text, field) {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(text)
  return match ? Number(match[1]) : null
}

/** The last snapshot of each pid from the preload's JSON lines. */
function latestSnapshots(lines, when) {
  const byPid = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (when && record.when !== when) continue
    byPid.set(record.pid, record)
  }
  return [...byPid.values()]
}

function topPackages(byPackage, count = 12) {
  return Object.entries(byPackage || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([name, modules]) => ({ name, modules }))
}

const METRICS = [
  ["install.bytes", "install size", "bytes"],
  ["install.files", "install files", "count"],
  ["install.packages", "install packages", "count"],
  ["cli.wallMs", "`ouro --version` wall time (median)", "ms"],
  ["cli.maxRssKb", "`ouro --version` peak RSS", "kB"],
  ["cli.modules", "`ouro --version` modules loaded", "count"],
  ["daemon.readyMs", "daemon (no agents) time to socket", "ms"],
  ["daemon.idleRssKb", "daemon (no agents) idle RSS", "kB"],
  ["daemon.idlePssKb", "daemon (no agents) idle PSS", "kB"],
  ["daemon.modules", "daemon (no agents) modules loaded", "count"],
  ["stack.upMs", "one-agent stack: `ouro up` wall time", "ms"],
  ["stack.vaultCalls", "one-agent stack: vault CLI runs during `ouro up`", "count"],
  ["stack.processes", "one-agent stack: processes", "count"],
  ["stack.idleRssKb", "one-agent stack: idle RSS, all processes", "kB"],
  ["stack.idlePssKb", "one-agent stack: idle PSS, all processes", "kB"],
  ["stack.modules", "one-agent stack: modules loaded, all processes", "count"],
  ["turn.firstRequestMs", "turn: message to first model request", "ms"],
  ["turn.settledMs", "turn: message to quiet", "ms"],
  ["turn.modelRequests", "turn: model requests", "count"],
  ["turn.vaultCalls", "turn: vault CLI runs", "count"],
  ["turn.peakProcesses", "turn: peak processes", "count"],
  ["turn.peakRssKb", "turn: peak RSS, all processes", "kB"],
  ["turn.peakPssKb", "turn: peak PSS, all processes", "kB"],
]

function metricValue(result, key) {
  const value = key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), result)
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function formatValue(value, unit) {
  if (value === null) return "—"
  if (unit === "bytes") return `${(value / 1024 / 1024).toFixed(1)} MiB`
  if (unit === "kB") return `${(value / 1024).toFixed(1)} MiB`
  if (unit === "ms") return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
  return String(value)
}

/** Rows of { key, label, current, baseline, delta } and the markdown report. */
function compare(current, baseline) {
  const rows = METRICS.map(([key, label, unit]) => {
    const now = metricValue(current, key)
    const before = baseline ? metricValue(baseline, key) : null
    const delta = now !== null && before !== null && before !== 0 ? (now - before) / before : null
    return { key, label, unit, current: now, baseline: before, delta }
  })
  return rows
}

function deltaText(delta) {
  if (delta === null) return ""
  const percent = (delta * 100).toFixed(1)
  if (Math.abs(delta) < 0.005) return "±0%"
  return delta < 0 ? `**${percent}%** 🟢` : `+${percent}% 🔺`
}

function renderReport(current, baseline, baselineLabel) {
  const rows = compare(current, baseline)
  const host = current.host || {}
  const lines = [
    `### Edge benchmark: ${host.platform}-${host.arch}${host.memoryCapMiB ? `, ${host.memoryCapMiB} MiB memory cap` : ""}`,
    "",
    `Node ${host.node}, ${host.cpus} × ${host.cpuModel || "cpu"}, ${formatValue(host.totalMemBytes, "bytes")} RAM. ` +
      `Package ${current.package?.version ?? "?"}${current.package?.source ? ` (${current.package.source})` : ""}. ` +
      (baseline ? `Compared with ${baselineLabel || "the baseline"}.` : "No baseline yet."),
    "",
    "| Metric (lower is better) | This run | Baseline | Change |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.label} | ${formatValue(row.current, row.unit)} | ${formatValue(row.baseline, row.unit)} | ${deltaText(row.delta)} |`),
  ]
  const heavy = current.cli?.topPackages
  if (heavy?.length) {
    lines.push("", `<details><summary>What \`ouro --version\` loads (modules per package)</summary>`, "")
    lines.push(heavy.map((entry) => `${entry.name} ${entry.modules}`).join(" · "), "", "</details>")
  }
  if (current.errors?.length) {
    lines.push("", "**Scenario errors:**", ...current.errors.map((error) => `- ${error}`))
  }
  return `${lines.join("\n")}\n`
}

// ── measurement ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started
    await sleep(intervalMs)
  }
  return null
}

function readProc(pid, file) {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, "utf8") } catch { return null }
}

function psTable() {
  return parsePsTable(spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { encoding: "utf8" }).stdout || "")
}

/**
 * Memory of the process tree rooted at `root`, leaving out the benchmark's own
 * fakes (any process whose command line contains `exclude`). PSS and anonymous
 * RSS are Linux-only.
 */
function treeMemory(root, exclude) {
  const table = psTable()
  const pids = treePids(table, root).filter((pid) => !exclude || !table.get(pid).args.includes(exclude))
  const roles = pids.map((pid) => ({ role: processRole(table.get(pid).args), rssKb: table.get(pid).rssKb }))
  let rssKb = 0
  let pssKb = 0
  let anonKb = 0
  let linux = process.platform === "linux"
  for (const pid of pids) {
    rssKb += table.get(pid).rssKb
    if (linux) {
      const pss = procField(readProc(pid, "smaps_rollup") || "", "Pss")
      const anon = procField(readProc(pid, "status") || "", "RssAnon")
      if (pss === null || anon === null) linux = false
      else { pssKb += pss; anonKb += anon }
    }
  }
  return { processes: pids.length, rssKb, pssKb: linux ? pssKb : null, anonKb: linux ? anonKb : null, roles }
}

/** Samples a tree's memory every `intervalMs` and keeps the peak. */
function startSampler(root, exclude, intervalMs = 100) {
  const state = { peakRssKb: 0, peakPssKb: null, peakProcesses: 0, last: null, samples: 0 }
  const tick = () => {
    const memory = treeMemory(root, exclude)
    if (memory.processes === 0) return
    state.last = memory
    state.samples += 1
    if (memory.rssKb > state.peakRssKb) state.peakRoles = memory.roles
    state.peakRssKb = Math.max(state.peakRssKb, memory.rssKb)
    state.peakProcesses = Math.max(state.peakProcesses, memory.processes)
    if (memory.pssKb !== null) state.peakPssKb = Math.max(state.peakPssKb ?? 0, memory.pssKb)
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  return { state, stop: () => { clearInterval(timer); tick(); return state } }
}

function benchEnv(extra) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(PRELOAD)}`].filter(Boolean).join(" ")
  return { ...process.env, NODE_OPTIONS: nodeOptions, ...extra }
}

function dirStats(root) {
  let bytes = 0
  let files = 0
  let packages = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const parent = path.basename(dir)
        const inModules = parent === "node_modules" || (parent.startsWith("@") && path.basename(path.dirname(dir)) === "node_modules")
        if (inModules && !entry.name.startsWith(".") && !entry.name.startsWith("@") && fs.existsSync(path.join(full, "package.json"))) packages += 1
        walk(full)
      } else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(root)
  return { bytes, files, packages }
}

function hostInfo(options) {
  const cpus = os.cpus()
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    cpus: cpus.length,
    cpuModel: cpus[0]?.model?.trim() || null,
    totalMemBytes: os.totalmem(),
    memoryCapMiB: options.memoryCapMib ? Number(options.memoryCapMib) : null,
  }
}

function install(tarball, workDir) {
  const prefix = path.join(workDir, "install")
  fs.mkdirSync(prefix, { recursive: true })
  const started = Date.now()
  const result = spawnSync("npm", ["install", path.resolve(tarball), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`npm install failed: ${result.stderr || result.stdout}`)
  const root = path.join(prefix, "node_modules", "@ouro.bot", "cli")
  return { root, install: { ms: Date.now() - started, tarballBytes: fs.statSync(tarball).size, ...dirStats(prefix) } }
}

async function measureCli(root, workDir, runs) {
  const home = path.join(workDir, "cli-home")
  fs.mkdirSync(home, { recursive: true })
  const wall = []
  let snapshot = null
  for (let run = 0; run < runs; run += 1) {
    const out = path.join(workDir, `cli-${run}.jsonl`)
    const started = process.hrtime.bigint()
    const result = spawnSync(process.execPath, [path.join(root, "dist", "heart", "daemon", "ouro-entry.js"), "--version"], {
      cwd: home,
      env: benchEnv({ HOME: home, EDGE_BENCH_OUT: out }),
      encoding: "utf8",
    })
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    if (result.status !== 0) throw new Error(`ouro --version exited ${result.status}: ${result.stderr}`)
    wall.push(Math.round(elapsed))
    snapshot = latestSnapshots(fs.readFileSync(out, "utf8").split("\n"), "exit")[0] || snapshot
  }
  return {
    wallMs: median(wall),
    wallMsRuns: wall,
    maxRssKb: snapshot?.maxRssKb ?? null,
    modules: snapshot?.modules ?? null,
    topPackages: topPackages(snapshot?.byPackage),
  }
}

async function stopTree(pid, timeoutMs = 10_000) {
  try { process.kill(pid, "SIGTERM") } catch { return }
  const gone = await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, timeoutMs, 100)
  if (gone === null) { try { process.kill(pid, "SIGKILL") } catch { /* already gone */ } }
}

async function measureDaemon(root, workDir, idleSeconds) {
  const home = path.join(workDir, "daemon-home")
  fs.mkdirSync(home, { recursive: true })
  const socket = path.join(workDir, "daemon.sock")
  const out = path.join(workDir, "daemon.jsonl")
  const started = Date.now()
  const child = spawn(process.execPath, [path.join(root, "dist", "heart", "daemon", "daemon-entry.js"), "--socket", socket], {
    cwd: home,
    env: benchEnv({ HOME: home, EDGE_BENCH_OUT: out, EDGE_BENCH_SNAP_AT: String(idleSeconds) }),
    stdio: "ignore",
  })
  try {
    const readyMs = await waitFor(() => fs.existsSync(socket), 120_000)
    if (readyMs === null) throw new Error("daemon never opened its socket")
    await sleep(Math.max(0, idleSeconds * 1000 - (Date.now() - started)) + 500)
    const memory = treeMemory(child.pid)
    const snapshot = latestSnapshots(fs.readFileSync(out, "utf8").split("\n")).find((record) => record.pid === child.pid)
    return {
      readyMs,
      processes: memory.processes,
      idleRssKb: memory.rssKb,
      idlePssKb: memory.pssKb,
      idleAnonKb: memory.anonKb,
      modules: snapshot?.modules ?? null,
      topPackages: topPackages(snapshot?.byPackage),
    }
  } finally {
    await stopTree(child.pid)
  }
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 })
}

// A vault CLI and OS unlock stores that answer from JSON files, so the stack
// runs with no network and no real secrets. Same contract as the hermetic
// integration lane's fakes.
function writeFakes(binDir, statePath, unlockPath) {
  const reader = `const fs = require("fs")\nconst read = (p) => JSON.parse(fs.readFileSync(p, "utf8"))\nconst write = (p, v) => fs.writeFileSync(p, JSON.stringify(v))\nconst args = process.argv.slice(2)\n`
  writeExecutable(path.join(binDir, "bw"), `#!/usr/bin/env node
${reader}const statePath = ${JSON.stringify(statePath)}
fs.appendFileSync(statePath + ".calls", (args[0] || "") + "\\n")
const state = read(statePath)
const password = () => { const i = args.indexOf("--passwordenv"); return i >= 0 ? process.env[args[i + 1]] : args[args[0] === "login" ? 2 : 1] }
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0) }
if (args[0] === "status") out({ status: state.status, serverUrl: state.serverUrl || undefined, userEmail: state.status === "unlocked" ? state.email : undefined })
if (args[0] === "config" && args[1] === "server") { state.serverUrl = args[2]; write(statePath, state); out("") }
if (args[0] === "login" || args[0] === "unlock") {
  if (password() !== state.secret) { process.stderr.write("invalid master password\\n"); process.exit(1) }
  state.status = "unlocked"; write(statePath, state); out(state.session + "\\n")
}
if (args[0] === "sync") out("")
if (args[0] === "list" && args[1] === "items") { const i = args.indexOf("--search"); out(i < 0 ? state.items : state.items.filter((item) => item.name === args[i + 1] || (item.login.uris || []).some((u) => String(u.uri).includes(args[i + 1])))) }
if (args[0] === "get" && args[1] === "item") { const item = state.items.find((e) => e.id === args[2] || e.name === args[2]); if (!item) { process.stderr.write("item not found\\n"); process.exit(1) } out(item) }
if ((args[0] === "create" || args[0] === "edit") && args[1] === "item") {
  const payload = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"))
  const index = args[0] === "edit" ? state.items.findIndex((e) => e.id === args[2]) : -1
  const item = { ...(index >= 0 ? state.items[index] : {}), ...payload, id: index >= 0 ? state.items[index].id : "item-" + (state.items.length + 1), revisionDate: new Date().toISOString() }
  if (index >= 0) state.items[index] = item; else state.items.push(item)
  write(statePath, state); out({ id: item.id })
}
if (args[0] === "delete" && args[1] === "item") { state.items = state.items.filter((e) => e.id !== args[2]); write(statePath, state); out("") }
process.stderr.write("unexpected fake bw args: " + JSON.stringify(args) + "\\n"); process.exit(1)
`)
  const unlock = (name, lookup, store) => writeExecutable(path.join(binDir, name), `#!/usr/bin/env node
${reader}const unlockPath = ${JSON.stringify(unlockPath)}
const after = (flag) => args[args.indexOf(flag) + 1]
${lookup}
${store}
process.stderr.write("unexpected fake ${name} args: " + JSON.stringify(args) + "\\n"); process.exit(1)
`)
  unlock("security",
    `if (args[0] === "find-generic-password") { const v = read(unlockPath)[after("-s") + ":" + after("-a")]; if (!v) process.exit(44); process.stdout.write(v + "\\n"); process.exit(0) }`,
    `if (args[0] === "add-generic-password") { const s = read(unlockPath); s[after("-s") + ":" + after("-a")] = after("-w"); write(unlockPath, s); process.exit(0) }`)
  unlock("secret-tool",
    `if (args[0] === "--version") { process.stdout.write("fake-secret-tool 1.0\\n"); process.exit(0) }\nif (args[0] === "lookup") { const v = read(unlockPath)[after("service") + ":" + after("account")]; if (!v) process.exit(1); process.stdout.write(v + "\\n"); process.exit(0) }`,
    `if (args[0] === "store") { const s = read(unlockPath); s[after("service") + ":" + after("account")] = fs.readFileSync(0, "utf8").trim(); write(unlockPath, s); process.exit(0) }`)
}

/** An OpenAI-compatible model that answers every request at once and logs when each arrived. */
async function startFakeModel() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      requests.push({ at: Date.now(), url: req.url, bytes: body.length })
      if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "not found" } }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "chatcmpl-edge",
        object: "chat.completion",
        created: 1,
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

function seedAgent(home, baseUrl) {
  const bundlesRoot = path.join(home, "AgentBundles")
  const agentRoot = path.join(bundlesRoot, `${AGENT}.ouro`)
  for (const dir of ["state", "friends", "inbox", "tasks", "desk/_record/diary/daily", "desk/_record/notes"]) {
    fs.mkdirSync(path.join(agentRoot, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "github-copilot", model: MODEL },
    agentFacing: { provider: "github-copilot", model: MODEL },
    senses: { cli: { enabled: false }, teams: { enabled: false }, bluebubbles: { enabled: false } },
    sync: { enabled: false },
    phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    vault: { email: VAULT_EMAIL, serverUrl: VAULT_SERVER_URL },
  }, null, 2)}\n`)
  const updatedAt = new Date().toISOString()
  const credential = JSON.stringify({
    schemaVersion: 1,
    kind: "provider-credential",
    provider: "github-copilot",
    updatedAt,
    credentials: { githubToken: "edge-benchmark-token" },
    config: { baseUrl },
    provenance: { source: "manual", updatedAt },
  })
  return {
    bundlesRoot,
    vaultState: {
      status: "unauthenticated",
      serverUrl: "",
      email: VAULT_EMAIL,
      secret: VAULT_SECRET,
      session: "edge-benchmark-session",
      items: [{
        id: "provider-github-copilot",
        name: "providers/github-copilot",
        login: { username: "github-copilot", password: credential, uris: [{ uri: "https://providers/github-copilot" }] },
        notes: "edge benchmark provider credential",
        revisionDate: updatedAt,
      }],
    },
  }
}

async function measureStack(root, workDir, options) {
  const stackDir = path.join(workDir, "stack")
  const home = path.join(stackDir, "home")
  const binDir = path.join(stackDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  const model = await startFakeModel()
  const { bundlesRoot, vaultState } = seedAgent(home, model.baseUrl)
  const statePath = path.join(stackDir, "vault.json")
  const unlockPath = path.join(stackDir, "unlock.json")
  fs.writeFileSync(statePath, JSON.stringify(vaultState))
  fs.writeFileSync(unlockPath, JSON.stringify({ [`ouro.vault:${VAULT_SERVER_URL}:${VAULT_EMAIL}`]: VAULT_SECRET }))
  writeFakes(binDir, statePath, unlockPath)
  const vaultCalls = () => {
    try { return fs.readFileSync(`${statePath}.calls`, "utf8").split("\n").filter(Boolean).length } catch { return 0 }
  }

  const socket = path.join(stackDir, "daemon.sock")
  const pidFile = path.join(stackDir, "daemon.pid")
  const out = path.join(stackDir, "stack.jsonl")
  const env = benchEnv({
    HOME: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    OURO_BW_BINARY: path.join(binDir, "bw"),
    EDGE_BENCH_OUT: out,
    EDGE_BENCH_SNAP_AT: String(options.idleSeconds),
  })
  // Async on purpose: the fake model answers from this process's event loop.
  const cli = (args) => new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [CLI_RUNNER, root, socket, bundlesRoot, home, pidFile, JSON.stringify(args)], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    child.on("close", (status) => { clearTimeout(timer); resolve({ ms: Date.now() - started, status, stdout, stderr }) })
  })

  let daemonPid = null
  try {
    const up = await cli(["up", "--no-repair"])
    if (up.status !== 0) throw new Error(`ouro up exited ${up.status}: ${(up.stdout + up.stderr).slice(-800)}`)
    daemonPid = Number(fs.readFileSync(pidFile, "utf8"))
    const upStarted = Date.now() - up.ms
    // Idle: wait for the processes to settle, then read the tree once.
    await sleep(Math.max(0, options.idleSeconds * 1000 - (Date.now() - upStarted)) + 1000)
    const idle = treeMemory(daemonPid, binDir)
    const snapshots = latestSnapshots(fs.readFileSync(out, "utf8").split("\n"))
    const tree = new Set(treePids(psTable(), daemonPid))
    const inTree = snapshots.filter((record) => tree.has(record.pid) && !FAKES.has(record.role))
    const stack = {
      upMs: up.ms,
      vaultCalls: vaultCalls(),
      processes: idle.processes,
      idleRssKb: idle.rssKb,
      idlePssKb: idle.pssKb,
      idleAnonKb: idle.anonKb,
      modules: inTree.reduce((sum, record) => sum + record.modules, 0) || null,
      roles: inTree.map((record) => ({ role: record.role, modules: record.modules, rssKb: Math.round(record.rss / 1024) })),
    }

    // Turn: one operator message, measured until the stack is quiet again.
    const before = model.requests.length
    const vaultBefore = vaultCalls()
    const sampler = startSampler(daemonPid, binDir)
    const sent = Date.now()
    const msg = await cli(["msg", "--to", AGENT, "edge benchmark: say pong"])
    if (msg.status !== 0) throw new Error(`ouro msg exited ${msg.status}: ${(msg.stdout + msg.stderr).slice(-800)}`)
    const firstWait = await waitFor(() => model.requests.length > before, options.turnTimeoutMs)
    let settledMs = null
    if (firstWait !== null) {
      await waitFor(() => Date.now() - model.requests[model.requests.length - 1].at >= options.turnQuietMs, options.turnTimeoutMs)
      settledMs = model.requests[model.requests.length - 1].at - sent
    }
    const peak = sampler.stop()
    const turn = {
      firstRequestMs: firstWait === null ? null : model.requests[before].at - sent,
      settledMs,
      modelRequests: model.requests.length - before,
      vaultCalls: vaultCalls() - vaultBefore,
      peakProcesses: peak.peakProcesses,
      peakRssKb: peak.peakRssKb,
      peakPssKb: peak.peakPssKb,
      afterRssKb: peak.last?.rssKb ?? null,
      processes: peak.last?.processes ?? null,
      roles: peak.last?.roles ?? [],
      peakRoles: peak.peakRoles ?? [],
    }
    return { stack, turn }
  } finally {
    await cli(["stop"])
    if (daemonPid) await stopTree(daemonPid)
    await new Promise((resolve) => model.server.close(resolve))
  }
}

async function run(options) {
  if (!options.out) throw new Error("--out is required")
  if (!options.tarball === !options.root) throw new Error("give exactly one of --tarball or --root")
  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ouro-edge-"))
  const result = { schemaVersion: 1, at: new Date().toISOString(), host: hostInfo(options), errors: [] }
  let root = options.root ? path.resolve(options.root) : null
  if (options.tarball) {
    const installed = install(options.tarball, workDir)
    root = installed.root
    result.install = installed.install
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  result.package = { version: pkg.version, source: options.tarball ? "packed" : "checkout" }

  const scenario = async (name, fn) => {
    const started = Date.now()
    try {
      Object.assign(result, await fn())
      process.stderr.write(`edge-benchmark: ${name} done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      process.stderr.write(`edge-benchmark: ${name} FAILED: ${error instanceof Error ? error.stack : error}\n`)
    }
  }
  await scenario("cli", async () => ({ cli: await measureCli(root, workDir, options.runs) }))
  await scenario("daemon", async () => ({ daemon: await measureDaemon(root, workDir, options.idleSeconds) }))
  await scenario("stack", async () => measureStack(root, workDir, options))

  fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`)
  process.stderr.write(`edge-benchmark: wrote ${options.out} (work dir ${workDir})\n`)
  return result
}

function report(options) {
  if (!options.current) throw new Error("--current is required")
  const current = JSON.parse(fs.readFileSync(options.current, "utf8"))
  const baseline = options.baseline && fs.existsSync(options.baseline) ? JSON.parse(fs.readFileSync(options.baseline, "utf8")) : null
  const markdown = renderReport(current, baseline, options.baselineLabel)
  process.stdout.write(markdown)
  if (options.summary) fs.appendFileSync(options.summary, markdown)
  // A scenario that could not run is a broken benchmark, not a slow harness.
  if (current.errors?.length) process.exitCode = 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === "run") await run(options)
  else if (options.command === "report") report(options)
  else throw new Error("usage: edge-benchmark.cjs run (--tarball <tgz> | --root <dir>) --out <json> | report --current <json> [--baseline <json>] [--summary <file>]")
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}

module.exports = { parseArgs, median, parsePsTable, processRole, treePids, procField, latestSnapshots, topPackages, compare, renderReport, formatValue, metricValue, METRICS }
