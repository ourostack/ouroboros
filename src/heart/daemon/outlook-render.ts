import { emitNervesEvent } from "../../nerves/runtime"
import { OUTLOOK_PRODUCT_NAME, type OutlookMachineState, type OutlookMachineView } from "./outlook-types"

interface RenderOutlookAppInput {
  origin: string
  machine: OutlookMachineState
  machineView?: OutlookMachineView
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
}

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
}

function firstAgentName(machineView: OutlookMachineView | undefined): string {
  return machineView?.agents[0]?.agentName ?? ""
}

function renderAgentButtons(machineView: OutlookMachineView | undefined): string {
  const agents = machineView?.agents ?? []
  if (agents.length === 0) {
    return [
      "<div class=\"outlook-empty-agent-list\">",
      "  <p>No agents are visible yet.</p>",
      "  <p>When the daemon sees enabled bundles on this machine, they will gather here.</p>",
      "</div>",
    ].join("\n")
  }

  return agents.map((agent, index) => [
    `<button class="outlook-agent-chip${index === 0 ? " is-selected" : ""}" type="button" data-agent-name="${escapeHtml(agent.agentName)}">`,
    `  <span class="outlook-agent-chip__name">${escapeHtml(agent.agentName)}</span>`,
    `  <span class="outlook-agent-chip__attention attention-${escapeHtml(agent.attention.level)}">${escapeHtml(agent.attention.label)}</span>`,
    `  <span class="outlook-agent-chip__meta">${agent.tasks.liveCount} live tasks · ${agent.coding.activeCount} coding · ${agent.obligations.openCount} obligations</span>`,
    "</button>",
  ].join("\n")).join("\n")
}

function renderOverviewCards(machineView: OutlookMachineView | undefined, machine: OutlookMachineState): string {
  const agents = Array.isArray(machine.agents) ? machine.agents : []
  const totals = machineView?.overview.totals ?? {
    agents: machine.agentCount,
    enabledAgents: agents.filter((agent) => agent.enabled).length,
    degradedAgents: agents.filter((agent) => agent.degraded?.status === "degraded").length,
    staleAgents: agents.filter((agent) => agent.freshness?.status === "stale").length,
    liveTasks: agents.reduce((sum, agent) => sum + (agent.tasks?.liveCount ?? 0), 0),
    blockedTasks: agents.reduce((sum, agent) => sum + (agent.tasks?.blockedCount ?? 0), 0),
    openObligations: agents.reduce((sum, agent) => sum + (agent.obligations?.openCount ?? 0), 0),
    activeCodingAgents: agents.reduce((sum, agent) => sum + (agent.coding?.activeCount ?? 0), 0),
    blockedCodingAgents: agents.reduce((sum, agent) => sum + (agent.coding?.blockedCount ?? 0), 0),
  }

  const cards = [
    { label: "Visible agents", value: totals.agents.toString() },
    { label: "Live tasks", value: totals.liveTasks.toString() },
    { label: "Open obligations", value: totals.openObligations.toString() },
    { label: "Active coding", value: totals.activeCodingAgents.toString() },
    { label: "Blocked tasks", value: totals.blockedTasks.toString() },
    { label: "Stale agents", value: totals.staleAgents.toString() },
  ]

  return cards.map((card) => [
    "<article class=\"outlook-stat-card\">",
    `  <span class="outlook-kicker">${escapeHtml(card.label)}</span>`,
    `  <strong class="outlook-stat-card__value">${escapeHtml(card.value)}</strong>`,
    "</article>",
  ].join("\n")).join("\n")
}

function renderEntrypoints(machineView: OutlookMachineView | undefined, origin: string): string {
  const entrypoints = machineView?.overview.entrypoints ?? [
    { kind: "web", label: "Open Outlook", target: `${origin}/outlook` },
    { kind: "cli", label: "CLI JSON", target: "ouro outlook --json" },
  ]

  return entrypoints.map((entrypoint) => [
    "<div class=\"outlook-entrypoint\">",
    `  <span class="outlook-kicker">${escapeHtml(entrypoint.label)}</span>`,
    `  <code>${escapeHtml(entrypoint.target)}</code>`,
    "</div>",
  ].join("\n")).join("\n")
}

function renderRuntimeFacts(machineView: OutlookMachineView | undefined, machine: OutlookMachineState): string {
  const runtime = machineView?.overview.runtime ?? machine.runtime
  const daemon = machineView?.overview.daemon
  const freshness = machineView?.overview.freshness ?? machine.freshness
  const degraded = machineView?.overview.degraded ?? machine.degraded
  const latestActivity = freshness?.latestActivityAt ?? "unknown"

  return [
    `<div class="outlook-fact"><span class="outlook-kicker">Runtime</span><strong>${escapeHtml(runtime?.version ?? "unknown")}</strong></div>`,
    `<div class="outlook-fact"><span class="outlook-kicker">Mode</span><strong>${escapeHtml(daemon?.mode ?? "production")}</strong></div>`,
    `<div class="outlook-fact"><span class="outlook-kicker">Freshness</span><strong>${escapeHtml(freshness?.status ?? "unknown")}</strong></div>`,
    `<div class="outlook-fact"><span class="outlook-kicker">Latest activity</span><strong>${escapeHtml(latestActivity)}</strong></div>`,
    `<div class="outlook-fact"><span class="outlook-kicker">Degraded</span><strong>${escapeHtml(degraded?.status ?? "ok")}</strong></div>`,
  ].join("\n")
}

const APP_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600&family=Outfit:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --outlook-void: #07110d;
  --outlook-deep: #102116;
  --outlook-moss: #183325;
  --outlook-scale: #2f8f4e;
  --outlook-glow: #74e08f;
  --outlook-bone: #eef2ea;
  --outlook-mist: #a5b8a8;
  --outlook-shadow: #708373;
  --outlook-fang: #d35f47;
  --outlook-line: rgba(110, 160, 117, 0.22);
  --outlook-panel: rgba(10, 22, 16, 0.74);
  --outlook-panel-strong: rgba(13, 29, 21, 0.9);
  --outlook-glass: rgba(21, 44, 32, 0.4);
  --outlook-ring: rgba(116, 224, 143, 0.14);
  --outlook-gold: #d6b56f;
  --outlook-font-display: "Cormorant Garamond", "Iowan Old Style", "Palatino Linotype", serif;
  --outlook-font-body: "Outfit", "Avenir Next", "Segoe UI Variable Text", sans-serif;
  --outlook-font-mono: "JetBrains Mono", "SFMono-Regular", monospace;
  --outlook-radius-lg: 28px;
  --outlook-radius-md: 18px;
  --outlook-radius-sm: 12px;
  --outlook-shadow-lg: 0 30px 80px rgba(0, 0, 0, 0.38);
}
* { box-sizing: border-box; margin: 0; }
html { color-scheme: dark; }
body {
  min-height: 100vh;
  font-family: var(--outlook-font-body);
  color: var(--outlook-bone);
  background:
    radial-gradient(circle at top left, rgba(116, 224, 143, 0.12), transparent 28%),
    radial-gradient(circle at 85% 15%, rgba(214, 181, 111, 0.08), transparent 24%),
    linear-gradient(180deg, #08110d 0%, #0c1a12 42%, #07110d 100%);
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
  background-size: 34px 34px;
  mask-image: radial-gradient(circle at center, black 30%, transparent 82%);
  opacity: 0.35;
}
body::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at 20% 20%, rgba(116, 224, 143, 0.09), transparent 22%),
    radial-gradient(circle at 70% 78%, rgba(47, 143, 78, 0.08), transparent 25%);
  filter: blur(40px);
  opacity: 0.75;
}
.outlook-shell {
  position: relative;
  z-index: 1;
  max-width: 1520px;
  margin: 0 auto;
  padding: 28px 22px 48px;
}
.outlook-sr-only {
  position: absolute;
  width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}

/* ─── NAV ─── */
.outlook-nav {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; margin-bottom: 20px; padding: 14px 18px;
  border: 1px solid var(--outlook-line); border-radius: 999px;
  background: rgba(8, 18, 13, 0.58); backdrop-filter: blur(20px);
  box-shadow: 0 14px 40px rgba(0,0,0,0.22);
}
.outlook-wordmark { display: flex; align-items: center; gap: 12px; }
.outlook-orb {
  width: 14px; height: 14px; border-radius: 999px;
  background: radial-gradient(circle at 30% 30%, #c9ffd7 0%, var(--outlook-glow) 30%, var(--outlook-scale) 70%, #173725 100%);
  box-shadow: 0 0 24px rgba(116, 224, 143, 0.45);
  animation: orb-breathe 4s ease-in-out infinite;
}
@keyframes orb-breathe {
  0%, 100% { box-shadow: 0 0 24px rgba(116, 224, 143, 0.45); }
  50% { box-shadow: 0 0 32px rgba(116, 224, 143, 0.65); }
}
.outlook-product {
  margin: 0; font-family: var(--outlook-font-display);
  font-size: clamp(1.5rem, 2vw, 2rem); font-style: italic; font-weight: 600;
}
.outlook-subtitle { margin: 2px 0 0; color: var(--outlook-mist); font-size: 0.85rem; }
.outlook-nav-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.outlook-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 11px; border-radius: 999px;
  border: 1px solid var(--outlook-line); background: rgba(12, 29, 20, 0.7);
  color: var(--outlook-bone); font-family: var(--outlook-font-mono);
  font-size: 0.7rem; letter-spacing: 0.05em; text-transform: uppercase;
}
.outlook-badge::before {
  content: ""; width: 7px; height: 7px; border-radius: 999px;
  background: var(--outlook-glow); box-shadow: 0 0 18px rgba(116, 224, 143, 0.45);
}

/* ─── HERO ─── */
.outlook-hero {
  position: relative; overflow: hidden;
  padding: clamp(24px, 3vw, 42px); border-radius: calc(var(--outlook-radius-lg) + 8px);
  border: 1px solid rgba(116, 224, 143, 0.14);
  background: linear-gradient(135deg, rgba(9,18,14,0.97) 0%, rgba(13,30,21,0.94) 52%, rgba(11,21,16,0.95) 100%);
  box-shadow: var(--outlook-shadow-lg);
}
.outlook-hero::before {
  content: ""; position: absolute;
  inset: auto -8% -42% 36%; height: 420px;
  background: radial-gradient(circle, rgba(116,224,143,0.18) 0%, rgba(116,224,143,0.04) 35%, transparent 70%);
  filter: blur(10px);
}
.outlook-hero__grid {
  position: relative; display: grid; gap: 22px;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.9fr);
}
.outlook-kicker {
  display: inline-block; font-family: var(--outlook-font-mono);
  font-size: 0.68rem; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--outlook-glow);
}
.outlook-hero h1,
.outlook-section h2, .outlook-panel h2,
.outlook-agent-panel__empty strong,
.outlook-agent-card h3 {
  font-family: var(--outlook-font-display); font-style: italic;
  font-weight: 600; letter-spacing: 0.01em;
}
.outlook-hero h1 { margin-top: 14px; font-size: clamp(2.6rem, 5vw, 4.8rem); line-height: 0.94; max-width: 8.3ch; }
.outlook-hero p { max-width: 60ch; margin: 14px 0 0; color: var(--outlook-mist); font-size: 0.98rem; line-height: 1.8; }

/* ─── STATS ─── */
.outlook-stat-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.outlook-stat-card,
.outlook-facts, .outlook-entrypoints-panel, .outlook-agent-panel, .outlook-agents-rail {
  border: 1px solid var(--outlook-line); border-radius: var(--outlook-radius-lg);
  background: var(--outlook-panel); backdrop-filter: blur(18px);
}
.outlook-stat-card {
  min-height: 110px; padding: 16px; display: flex;
  flex-direction: column; justify-content: space-between;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
}
.outlook-stat-card__value { font-size: clamp(1.8rem, 3.5vw, 2.6rem); letter-spacing: -0.05em; }

/* ─── LAYOUT ─── */
.outlook-layout {
  display: grid; gap: 20px; margin-top: 20px;
  grid-template-columns: minmax(260px, 0.85fr) minmax(0, 1.75fr);
}
.outlook-agents-rail, .outlook-agent-panel, .outlook-facts, .outlook-entrypoints-panel { padding: 18px; }
.outlook-section, .outlook-panel { display: grid; gap: 14px; }
.outlook-section h2, .outlook-panel h2 { font-size: clamp(1.6rem, 2.2vw, 2.2rem); }

/* ─── AGENT CHIPS ─── */
.outlook-agent-list { display: grid; gap: 10px; }
.outlook-agent-chip {
  width: 100%; display: grid; gap: 4px; padding: 14px;
  border-radius: var(--outlook-radius-md);
  border: 1px solid rgba(116, 224, 143, 0.08);
  background: rgba(14, 31, 22, 0.72); color: inherit;
  text-align: left; cursor: pointer;
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
}
.outlook-agent-chip:hover, .outlook-agent-chip.is-selected {
  transform: translateY(-2px);
  border-color: rgba(116, 224, 143, 0.28); background: rgba(17, 39, 28, 0.88);
}
.outlook-agent-chip__name { font-family: var(--outlook-font-display); font-size: 1.35rem; font-style: italic; }
.outlook-agent-chip__attention, .outlook-agent-chip__meta { color: var(--outlook-mist); font-size: 0.84rem; }
.outlook-agent-chip__attention.attention-degraded,
.outlook-agent-chip__attention.attention-blocked { color: #ff8d79; }
.outlook-agent-chip__attention.attention-stale { color: var(--outlook-gold); }
.outlook-agent-chip__attention.attention-active { color: var(--outlook-glow); }
.outlook-empty-agent-list, .outlook-agent-panel__empty {
  padding: 20px; border-radius: var(--outlook-radius-md);
  border: 1px dashed rgba(116, 224, 143, 0.2);
  background: rgba(10, 22, 16, 0.6); color: var(--outlook-mist);
}
.outlook-empty-agent-list p, .outlook-agent-panel__empty p { margin: 0; line-height: 1.7; }
.outlook-empty-agent-list p + p, .outlook-agent-panel__empty p + p { margin-top: 8px; }

/* ─── TABS ─── */
.outlook-tabs {
  display: flex; gap: 2px; overflow-x: auto; padding-bottom: 2px;
  border-bottom: 1px solid var(--outlook-line);
  -webkit-overflow-scrolling: touch; scrollbar-width: none;
}
.outlook-tabs::-webkit-scrollbar { display: none; }
.outlook-tab {
  padding: 10px 16px; border: none; border-radius: 12px 12px 0 0;
  background: transparent; color: var(--outlook-mist); cursor: pointer;
  font-family: var(--outlook-font-mono); font-size: 0.72rem;
  letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap;
  transition: color 140ms ease, background 140ms ease;
}
.outlook-tab:hover { color: var(--outlook-bone); background: rgba(116, 224, 143, 0.06); }
.outlook-tab.is-active {
  color: var(--outlook-glow); background: rgba(116, 224, 143, 0.1);
  border-bottom: 2px solid var(--outlook-glow);
}
.outlook-tab-content { display: none; padding-top: 16px; }
.outlook-tab-content.is-visible { display: block; animation: tab-fade 200ms ease; }
@keyframes tab-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

/* ─── MACHINE FACTS ─── */
.outlook-facts { display: grid; gap: 14px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.outlook-fact {
  min-height: 82px; padding: 14px; border-radius: var(--outlook-radius-md);
  background: rgba(12, 26, 18, 0.74); border: 1px solid rgba(116, 224, 143, 0.08);
}
.outlook-fact strong { display: block; margin-top: 8px; font-size: 0.95rem; line-height: 1.5; }
.outlook-entrypoints-panel { display: grid; gap: 12px; }
.outlook-entrypoint {
  padding: 12px 14px; border-radius: var(--outlook-radius-md);
  background: rgba(12, 27, 19, 0.7); border: 1px solid rgba(116, 224, 143, 0.08);
}
.outlook-entrypoint code, .outlook-agent-panel code {
  display: block; margin-top: 6px; font-family: var(--outlook-font-mono);
  font-size: 0.8rem; color: var(--outlook-bone); white-space: pre-wrap; word-break: break-word;
}

/* ─── AGENT CARD / METERS ─── */
.outlook-agent-card { display: grid; gap: 16px; }
.outlook-agent-card h3 { font-size: clamp(1.8rem, 2.5vw, 2.6rem); }
.outlook-agent-card__lede { margin: 0; color: var(--outlook-mist); line-height: 1.8; font-size: 0.95rem; }
.outlook-agent-meta, .outlook-agent-senses, .outlook-agent-recent { display: grid; gap: 8px; }
.outlook-agent-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.outlook-agent-meter {
  padding: 12px; border-radius: var(--outlook-radius-md);
  background: rgba(11, 23, 17, 0.75); border: 1px solid rgba(116, 224, 143, 0.08);
}
.outlook-agent-meter strong { display: block; margin-top: 6px; font-size: 1.4rem; }
.outlook-agent-meter span { color: var(--outlook-mist); font-size: 0.84rem; }

/* ─── PILLS ─── */
.outlook-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.outlook-pill {
  display: inline-flex; align-items: center; padding: 5px 10px;
  border-radius: 999px; background: rgba(15, 39, 27, 0.7);
  border: 1px solid rgba(116, 224, 143, 0.1);
  color: var(--outlook-bone); font-size: 0.8rem;
}

/* ─── RECENT ACTIVITY ─── */
.outlook-recent-list { display: grid; gap: 8px; }
.outlook-recent-item {
  display: grid; gap: 3px; padding: 12px; border-radius: var(--outlook-radius-md);
  background: rgba(11, 23, 17, 0.72); border: 1px solid rgba(116, 224, 143, 0.08);
}
.outlook-recent-item small { color: var(--outlook-shadow); font-family: var(--outlook-font-mono); font-size: 0.7rem; }
.outlook-recent-item strong { font-size: 0.9rem; }
.outlook-recent-item span { color: var(--outlook-mist); font-size: 0.84rem; }

/* ─── SESSION LIST ─── */
.outlook-session-list { display: grid; gap: 8px; }
.outlook-session-row {
  display: grid; gap: 4px; padding: 14px; border-radius: var(--outlook-radius-md);
  background: rgba(11, 23, 17, 0.72); border: 1px solid rgba(116, 224, 143, 0.08);
  cursor: pointer; transition: border-color 140ms ease, background 140ms ease;
}
.outlook-session-row:hover, .outlook-session-row.is-expanded {
  border-color: rgba(116, 224, 143, 0.22); background: rgba(14, 30, 22, 0.85);
}
.outlook-session-row__header { display: flex; justify-content: space-between; align-items: center; }
.outlook-session-row__name { font-family: var(--outlook-font-display); font-style: italic; font-size: 1.15rem; }
.outlook-session-row__meta { color: var(--outlook-mist); font-size: 0.8rem; }
.outlook-session-row__excerpt { color: var(--outlook-shadow); font-size: 0.82rem; line-height: 1.5; margin-top: 2px; }

/* ─── TRANSCRIPT VIEWER ─── */
.outlook-transcript { display: none; margin-top: 10px; padding: 14px; border-radius: var(--outlook-radius-sm); background: rgba(7, 17, 13, 0.85); border: 1px solid var(--outlook-line); max-height: 500px; overflow-y: auto; }
.outlook-transcript.is-visible { display: block; animation: tab-fade 200ms ease; }
.outlook-msg { padding: 10px 0; border-bottom: 1px solid rgba(110, 160, 117, 0.1); }
.outlook-msg:last-child { border-bottom: none; }
.outlook-msg__role {
  display: inline-block; padding: 2px 8px; border-radius: 6px; margin-bottom: 4px;
  font-family: var(--outlook-font-mono); font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase;
}
.outlook-msg__role--system { background: rgba(116, 224, 143, 0.12); color: var(--outlook-glow); }
.outlook-msg__role--user { background: rgba(214, 181, 111, 0.15); color: var(--outlook-gold); }
.outlook-msg__role--assistant { background: rgba(116, 224, 143, 0.08); color: var(--outlook-bone); }
.outlook-msg__role--tool { background: rgba(165, 184, 168, 0.1); color: var(--outlook-mist); }
.outlook-msg__content { color: var(--outlook-bone); font-size: 0.85rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.outlook-msg__tool-calls { margin-top: 6px; }
.outlook-tool-call {
  padding: 8px 10px; margin-top: 4px; border-radius: 8px;
  background: rgba(15, 35, 25, 0.6); border: 1px solid rgba(116, 224, 143, 0.08);
  font-family: var(--outlook-font-mono); font-size: 0.76rem; color: var(--outlook-glow);
}
.outlook-tool-call__args { color: var(--outlook-mist); font-size: 0.72rem; margin-top: 4px; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; }

/* ─── OBLIGATION / CODING DEEP ─── */
.outlook-obligation-row, .outlook-coding-row, .outlook-bridge-row, .outlook-habit-row {
  padding: 12px; border-radius: var(--outlook-radius-md);
  background: rgba(11, 23, 17, 0.72); border: 1px solid rgba(116, 224, 143, 0.08);
  margin-bottom: 8px;
}
.outlook-obligation-row__status, .outlook-coding-row__status {
  display: inline-block; padding: 2px 8px; border-radius: 6px;
  font-family: var(--outlook-font-mono); font-size: 0.68rem; text-transform: uppercase;
  background: rgba(116, 224, 143, 0.08); color: var(--outlook-glow);
}
.outlook-coding-row__status--failed { background: rgba(211, 95, 71, 0.15); color: var(--outlook-fang); }
.outlook-coding-row__stdout, .outlook-coding-row__stderr {
  margin-top: 6px; padding: 8px; border-radius: 6px;
  background: rgba(7, 17, 13, 0.7); font-family: var(--outlook-font-mono);
  font-size: 0.72rem; color: var(--outlook-mist); white-space: pre-wrap; max-height: 100px; overflow-y: auto;
}

/* ─── DIARY / MEMORY ─── */
.outlook-diary-entry {
  padding: 10px 12px; border-radius: var(--outlook-radius-sm);
  background: rgba(11, 23, 17, 0.6); border: 1px solid rgba(116, 224, 143, 0.06);
  margin-bottom: 6px; font-size: 0.85rem; line-height: 1.6;
}
.outlook-diary-entry__source { color: var(--outlook-shadow); font-family: var(--outlook-font-mono); font-size: 0.68rem; }

/* ─── CENTER OF GRAVITY ─── */
.outlook-cog {
  padding: 18px; border-radius: var(--outlook-radius-lg);
  background: linear-gradient(135deg, rgba(13, 30, 22, 0.92) 0%, rgba(10, 22, 16, 0.88) 100%);
  border: 1px solid rgba(116, 224, 143, 0.18);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}
.outlook-cog__heading { font-family: var(--outlook-font-display); font-style: italic; font-size: 1.5rem; margin-bottom: 10px; }
.outlook-cog__pressures { display: grid; gap: 6px; margin-top: 10px; }
.outlook-pressure {
  display: flex; gap: 8px; align-items: center; padding: 8px 12px;
  border-radius: 10px; background: rgba(10, 22, 16, 0.65);
  border: 1px solid rgba(116, 224, 143, 0.06); font-size: 0.85rem;
}
.outlook-pressure__dot {
  width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0;
}
.outlook-pressure__dot--high { background: var(--outlook-fang); box-shadow: 0 0 10px rgba(211, 95, 71, 0.4); }
.outlook-pressure__dot--medium { background: var(--outlook-gold); box-shadow: 0 0 10px rgba(214, 181, 111, 0.3); }
.outlook-pressure__dot--low { background: var(--outlook-glow); box-shadow: 0 0 10px rgba(116, 224, 143, 0.3); }

/* ─── FOOTER ─── */
.outlook-footer-note {
  margin-top: 12px; color: var(--outlook-shadow);
  font-family: var(--outlook-font-mono); font-size: 0.72rem; letter-spacing: 0.04em;
}

/* ─── LOADING ─── */
.outlook-loading {
  padding: 20px; text-align: center; color: var(--outlook-mist);
  font-family: var(--outlook-font-mono); font-size: 0.8rem;
}

@media (max-width: 1080px) {
  .outlook-hero__grid, .outlook-layout { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .outlook-shell { padding-inline: 14px; }
  .outlook-nav { border-radius: 28px; align-items: flex-start; flex-direction: column; }
  .outlook-nav-meta, .outlook-facts, .outlook-stat-grid, .outlook-agent-meta { grid-template-columns: 1fr; }
}
`

const APP_SCRIPT = `
(function () {
  var root = document.querySelector('[data-outlook-app]');
  if (!root) return;

  var machineScript = document.getElementById('outlook-machine-view');
  var panel = document.querySelector('[data-outlook-agent-panel]');
  var list = document.querySelector('[data-outlook-agent-list]');
  var title = document.querySelector('[data-outlook-agent-title]');
  var subtitle = document.querySelector('[data-outlook-agent-subtitle]');
  var machineEndpoint = root.getAttribute('data-machine-endpoint');
  var agentEndpointBase = root.getAttribute('data-agent-endpoint-base');
  var selectedAgent = root.getAttribute('data-initial-agent') || '';
  var machineView = machineScript ? JSON.parse(machineScript.textContent || '{}') : null;
  var activeTab = 'overview';
  var cachedSurfaces = {};
  var lastAgentView = null;

  function setSelected(name) {
    selectedAgent = name || '';
    root.setAttribute('data-selected-agent', selectedAgent);
    cachedSurfaces = {};
    activeTab = 'overview';
    lastAgentView = null;
    if (!list) return;
    list.querySelectorAll('[data-agent-name]').forEach(function (button) {
      button.classList.toggle('is-selected', button.getAttribute('data-agent-name') === selectedAgent);
    });
  }

  function escapeHtml(value) {
    return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  }

  function relTime(iso) {
    if (!iso) return 'unknown';
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
    if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
    return Math.floor(ms/86400000) + 'd ago';
  }

  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  var TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'work', label: 'Work' },
    { id: 'connections', label: 'Connections' },
    { id: 'inner', label: 'Inner' },
    { id: 'memory', label: 'Memory' },
    { id: 'runtime', label: 'Runtime' },
  ];

  function renderTabs() {
    return '<div class="outlook-tabs">' +
      TABS.map(function(t) {
        return '<button class="outlook-tab' + (t.id === activeTab ? ' is-active' : '') + '" data-tab="' + t.id + '">' + t.label + '</button>';
      }).join('') + '</div>';
  }

  function renderOverviewTab(view) {
    var senses = view.agent.senses.length
      ? view.agent.senses.map(function(s) { return '<span class="outlook-pill">' + escapeHtml(s) + '</span>'; }).join('')
      : '<span class="outlook-pill">No active senses</span>';
    var bridges = view.work.bridges.length
      ? view.work.bridges.map(function(b) { return '<span class="outlook-pill">' + escapeHtml(b) + '</span>'; }).join('')
      : '<span class="outlook-pill">No active bridges</span>';
    var recent = view.activity.recent.length
      ? '<div class="outlook-recent-list">' + view.activity.recent.map(function(item) {
          return '<article class="outlook-recent-item"><small>' + escapeHtml(item.kind) + ' · ' + relTime(item.at) + '</small><strong>' + escapeHtml(truncate(item.label, 100)) + '</strong><span>' + escapeHtml(truncate(item.detail, 80)) + '</span></article>';
        }).join('') + '</div>'
      : '<p class="outlook-agent-card__lede">No recent activity yet.</p>';
    var innerSummary = view.inner.summary || view.inner.status;

    return '<article class="outlook-agent-card">' +
      '<div class="outlook-cog">' +
      '  <div class="outlook-kicker">Center of gravity</div>' +
      '  <div class="outlook-cog__heading">' + escapeHtml(view.agent.attention.label) + '</div>' +
      '  <p class="outlook-agent-card__lede">' + escapeHtml(view.agent.agentName) +
         ' has ' + view.work.tasks.liveCount + ' live tasks, ' +
         view.work.obligations.openCount + ' open obligations, ' +
         view.work.coding.activeCount + ' coding lanes, ' +
         'and is ' + escapeHtml(view.activity.freshness.status) + '.</p>' +
      (view.agent.degraded.status === 'degraded' && view.agent.degraded.issues.length
        ? '<div class="outlook-cog__pressures">' + view.agent.degraded.issues.map(function(issue) {
            return '<div class="outlook-pressure"><span class="outlook-pressure__dot outlook-pressure__dot--high"></span><span><strong>' + escapeHtml(issue.code) + '</strong> — ' + escapeHtml(issue.detail) + '</span></div>';
          }).join('') + '</div>'
        : '') +
      '</div>' +
      '<div class="outlook-agent-meta">' +
      '  <div class="outlook-agent-meter"><span class="outlook-kicker">Tasks</span><strong>' + view.work.tasks.liveCount + '</strong><span>' + view.work.tasks.blockedCount + ' blocked</span></div>' +
      '  <div class="outlook-agent-meter"><span class="outlook-kicker">Obligations</span><strong>' + view.work.obligations.openCount + '</strong><span>' + view.work.sessions.liveCount + ' live sessions</span></div>' +
      '  <div class="outlook-agent-meter"><span class="outlook-kicker">Coding</span><strong>' + view.work.coding.activeCount + '</strong><span>' + view.work.coding.blockedCount + ' blocked</span></div>' +
      '  <div class="outlook-agent-meter"><span class="outlook-kicker">Inner</span><strong>' + escapeHtml(view.inner.status) + '</strong><span>' + escapeHtml(truncate(innerSummary, 60) || 'No summary') + '</span></div>' +
      '</div>' +
      '<section class="outlook-agent-senses"><span class="outlook-kicker">Senses</span><div class="outlook-pills">' + senses + '</div></section>' +
      '<section class="outlook-agent-senses"><span class="outlook-kicker">Bridges</span><div class="outlook-pills">' + bridges + '</div></section>' +
      '<section class="outlook-agent-recent"><span class="outlook-kicker">Recent activity</span>' + recent + '</section>' +
      '</article>';
  }

  function renderSessionsTab(data) {
    if (!data || !data.items || data.items.length === 0) {
      return '<p class="outlook-agent-card__lede">No sessions found.</p>';
    }
    return '<div class="outlook-kicker" style="margin-bottom:8px">' + data.totalCount + ' sessions (' + data.activeCount + ' active, ' + data.staleCount + ' stale)</div>' +
      '<div class="outlook-session-list" data-session-list>' +
      data.items.map(function(s) {
        return '<div class="outlook-session-row" data-session-key="' + escapeHtml(s.friendId + '/' + s.channel + '/' + s.key) + '">' +
          '<div class="outlook-session-row__header">' +
          '  <span class="outlook-session-row__name">' + escapeHtml(s.friendName) + ' <small style="color:var(--outlook-mist);font-style:normal;font-size:0.75rem">via ' + escapeHtml(s.channel) + '</small></span>' +
          '  <span class="outlook-session-row__meta">' + s.messageCount + ' msgs · ' + relTime(s.lastActivityAt) + (s.lastUsage ? ' · ' + s.lastUsage.total_tokens + ' tok' : '') + '</span>' +
          '</div>' +
          (s.latestUserExcerpt ? '<div class="outlook-session-row__excerpt">' + escapeHtml(truncate(s.latestUserExcerpt, 120)) + '</div>' : '') +
          '<div class="outlook-transcript" data-transcript-for="' + escapeHtml(s.friendId + '/' + s.channel + '/' + s.key) + '"></div>' +
          '</div>';
      }).join('') + '</div>';
  }

  function renderTranscript(messages) {
    return messages.map(function(m) {
      var roleClass = 'outlook-msg__role--' + m.role;
      var html = '<div class="outlook-msg">';
      html += '<span class="outlook-msg__role ' + roleClass + '">' + escapeHtml(m.role) + (m.name ? ' (' + escapeHtml(m.name) + ')' : '') + '</span>';
      if (m.content) html += '<div class="outlook-msg__content">' + escapeHtml(m.content) + '</div>';
      if (m.tool_calls && m.tool_calls.length) {
        html += '<div class="outlook-msg__tool-calls">';
        m.tool_calls.forEach(function(tc) {
          html += '<div class="outlook-tool-call">' + escapeHtml(tc.function.name) +
            '<div class="outlook-tool-call__args">' + escapeHtml(truncate(tc.function.arguments, 300)) + '</div></div>';
        });
        html += '</div>';
      }
      if (m.tool_call_id) html += '<div style="color:var(--outlook-shadow);font-size:0.7rem;margin-top:2px">tool_call_id: ' + escapeHtml(m.tool_call_id) + '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  function renderWorkTab(view, coding) {
    var html = '';
    // Obligations
    html += '<div class="outlook-kicker" style="margin-bottom:6px">Obligations (' + view.work.obligations.openCount + ' open)</div>';
    if (view.work.obligations.items && view.work.obligations.items.length) {
      view.work.obligations.items.forEach(function(o) {
        html += '<div class="outlook-obligation-row">' +
          '<span class="outlook-obligation-row__status">' + escapeHtml(o.status) + '</span> ' +
          '<strong style="font-size:0.9rem">' + escapeHtml(truncate(o.content, 100)) + '</strong>' +
          (o.nextAction ? '<div style="color:var(--outlook-mist);font-size:0.82rem;margin-top:4px">Next: ' + escapeHtml(o.nextAction) + '</div>' : '') +
          '<div style="color:var(--outlook-shadow);font-size:0.72rem;margin-top:2px">' + relTime(o.updatedAt) + '</div></div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">No open obligations.</p>'; }

    // Coding
    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Coding lanes (' + (coding ? coding.totalCount : 0) + ')</div>';
    if (coding && coding.items && coding.items.length) {
      coding.items.forEach(function(c) {
        var statusClass = c.status === 'failed' ? ' outlook-coding-row__status--failed' : '';
        html += '<div class="outlook-coding-row">' +
          '<span class="outlook-coding-row__status' + statusClass + '">' + escapeHtml(c.status) + '</span> ' +
          '<strong style="font-size:0.88rem">' + escapeHtml(c.runner) + ' — ' + escapeHtml(c.workdir) + '</strong>' +
          (c.checkpoint ? '<div style="color:var(--outlook-mist);font-size:0.82rem;margin-top:4px">' + escapeHtml(truncate(c.checkpoint, 100)) + '</div>' : '') +
          '<div style="color:var(--outlook-shadow);font-size:0.72rem;margin-top:2px">pid ' + (c.pid||'-') + ' · restarts ' + c.restartCount + ' · ' + relTime(c.lastActivityAt) + '</div>' +
          (c.stdoutTail ? '<div class="outlook-coding-row__stdout">' + escapeHtml(truncate(c.stdoutTail, 300)) + '</div>' : '') +
          (c.failure ? '<div class="outlook-coding-row__stderr">FAILURE: ' + escapeHtml(c.failure.command) + ' exited ' + (c.failure.code||c.failure.signal) + '</div>' : '') +
          '</div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">No coding sessions.</p>'; }

    // Tasks
    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Tasks (' + view.work.tasks.liveCount + ' live)</div>';
    if (view.work.tasks.liveTaskNames && view.work.tasks.liveTaskNames.length) {
      html += '<div class="outlook-pills">' + view.work.tasks.liveTaskNames.map(function(t) { return '<span class="outlook-pill">' + escapeHtml(t) + '</span>'; }).join('') + '</div>';
    } else { html += '<p class="outlook-agent-card__lede">No live tasks.</p>'; }

    return html;
  }

  function renderConnectionsTab(attention, bridges, friends) {
    var html = '';
    // Attention queue
    html += '<div class="outlook-kicker" style="margin-bottom:6px">Attention queue (' + (attention ? attention.queueLength : 0) + ')</div>';
    if (attention && attention.queueItems && attention.queueItems.length) {
      attention.queueItems.forEach(function(item) {
        html += '<div class="outlook-obligation-row">' +
          '<strong style="font-size:0.88rem">' + escapeHtml(item.friendName) + '</strong> via ' + escapeHtml(item.channel) +
          '<div style="color:var(--outlook-mist);font-size:0.82rem;margin-top:3px">' + escapeHtml(truncate(item.delegatedContent, 120)) + '</div>' +
          (item.bridgeId ? '<div style="color:var(--outlook-shadow);font-size:0.72rem">bridge: ' + escapeHtml(item.bridgeId) + '</div>' : '') +
          '</div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">Nothing waiting.</p>'; }

    // Bridges
    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Bridges (' + (bridges ? bridges.totalCount : 0) + ')</div>';
    if (bridges && bridges.items && bridges.items.length) {
      bridges.items.forEach(function(b) {
        html += '<div class="outlook-bridge-row">' +
          '<span class="outlook-obligation-row__status">' + escapeHtml(b.lifecycle) + '</span> ' +
          '<strong style="font-size:0.88rem">' + escapeHtml(b.objective) + '</strong>' +
          '<div style="color:var(--outlook-mist);font-size:0.82rem;margin-top:3px">' + escapeHtml(truncate(b.summary, 120)) + '</div>' +
          '<div style="color:var(--outlook-shadow);font-size:0.72rem;margin-top:2px">' + b.attachedSessions.length + ' sessions · ' + relTime(b.updatedAt) + '</div>' +
          '</div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">No bridges.</p>'; }

    // Friends
    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Friends (' + (friends ? friends.totalFriends : 0) + ')</div>';
    if (friends && friends.friends && friends.friends.length) {
      friends.friends.forEach(function(f) {
        html += '<div class="outlook-obligation-row">' +
          '<strong style="font-size:0.88rem">' + escapeHtml(f.friendName) + '</strong>' +
          '<div style="color:var(--outlook-mist);font-size:0.82rem">' + f.totalTokens.toLocaleString() + ' tokens · ' + f.sessionCount + ' sessions · ' + f.channels.join(', ') + '</div>' +
          '</div>';
      });
    }

    return html;
  }

  function renderInnerTab(view, habits) {
    var html = '';
    html += '<div class="outlook-cog" style="margin-bottom:12px">' +
      '<div class="outlook-kicker">Inner work</div>' +
      '<div class="outlook-cog__heading">' + escapeHtml(view.inner.status) + '</div>' +
      (view.inner.summary ? '<p class="outlook-agent-card__lede">' + escapeHtml(view.inner.summary) + '</p>' : '') +
      '<p class="outlook-agent-card__lede" style="margin-top:6px">' + (view.inner.hasPending ? 'Pending inner work queued.' : 'No pending inner work.') + '</p>' +
      '</div>';

    if (view.inner.mode === 'deep' && view.inner.origin) {
      html += '<div class="outlook-kicker" style="margin:10px 0 4px">Origin</div>' +
        '<code style="font-size:0.8rem;display:block">' + escapeHtml(JSON.stringify(view.inner.origin)) + '</code>';
    }

    // Habits
    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Habits (' + (habits ? habits.totalCount : 0) + ')</div>';
    if (habits && habits.items && habits.items.length) {
      habits.items.forEach(function(h) {
        var overdueTag = h.isOverdue ? ' <span style="color:var(--outlook-fang)">OVERDUE</span>' : '';
        html += '<div class="outlook-habit-row">' +
          '<strong style="font-size:0.88rem">' + escapeHtml(h.title) + overdueTag + '</strong>' +
          '<div style="color:var(--outlook-mist);font-size:0.82rem">' + escapeHtml(h.status) + (h.cadence ? ' · every ' + escapeHtml(h.cadence) : '') + (h.lastRun ? ' · last ' + relTime(h.lastRun) : ' · never run') + '</div>' +
          (h.bodyExcerpt ? '<div style="color:var(--outlook-shadow);font-size:0.8rem;margin-top:3px">' + escapeHtml(h.bodyExcerpt) + '</div>' : '') +
          '</div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">No habits configured.</p>'; }

    return html;
  }

  function renderMemoryTab(memory) {
    var html = '';
    html += '<div class="outlook-kicker" style="margin-bottom:6px">Diary (' + (memory ? memory.diaryEntryCount : 0) + ' entries)</div>';
    if (memory && memory.recentDiaryEntries && memory.recentDiaryEntries.length) {
      memory.recentDiaryEntries.forEach(function(e) {
        html += '<div class="outlook-diary-entry">' +
          '<div class="outlook-diary-entry__source">' + escapeHtml(e.source) + ' · ' + relTime(e.createdAt) + '</div>' +
          escapeHtml(e.text) + '</div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">No diary entries.</p>'; }

    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Journal (' + (memory ? memory.journalEntryCount : 0) + ' entries)</div>';
    if (memory && memory.recentJournalEntries && memory.recentJournalEntries.length) {
      memory.recentJournalEntries.forEach(function(e) {
        html += '<div class="outlook-diary-entry">' +
          '<strong style="font-size:0.85rem">' + escapeHtml(e.filename) + '</strong>' +
          '<div style="color:var(--outlook-mist);font-size:0.82rem">' + escapeHtml(e.preview) + '</div></div>';
      });
    } else { html += '<p class="outlook-agent-card__lede">No journal entries.</p>'; }

    return html;
  }

  function renderRuntimeTab(health, logs, view) {
    var html = '';

    // Agent-level issues first — this is what "degraded" actually means
    if (view && view.agent.degraded.status === 'degraded' && view.agent.degraded.issues.length) {
      html += '<div class="outlook-kicker" style="margin-bottom:6px">Agent issues (' + view.agent.degraded.issues.length + ')</div>';
      view.agent.degraded.issues.forEach(function(issue) {
        html += '<div class="outlook-obligation-row" style="border-color:rgba(211,95,71,0.2)">' +
          '<strong style="color:var(--outlook-fang)">' + escapeHtml(issue.code) + '</strong>' +
          '<div style="color:var(--outlook-mist);font-size:0.82rem">' + escapeHtml(issue.detail) + '</div></div>';
      });
    }

    // Agent identity / config
    if (view) {
      html += '<div class="outlook-kicker" style="margin:14px 0 6px">Agent config</div>';
      html += '<div class="outlook-facts">' +
        '<div class="outlook-fact"><span class="outlook-kicker">Provider</span><strong>' + escapeHtml(view.agent.provider || 'none') + '</strong></div>' +
        '<div class="outlook-fact"><span class="outlook-kicker">Enabled</span><strong>' + (view.agent.enabled ? 'yes' : 'no') + '</strong></div>' +
        '<div class="outlook-fact"><span class="outlook-kicker">Freshness</span><strong>' + escapeHtml(view.agent.freshness.status) + (view.agent.freshness.ageMs ? ' (' + Math.floor(view.agent.freshness.ageMs / 60000) + 'm)' : '') + '</strong></div>' +
        '</div>';
    }

    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Daemon health</div>';
    if (health && health.status !== 'unavailable') {
      html += '<div class="outlook-facts" style="margin-bottom:12px">' +
        '<div class="outlook-fact"><span class="outlook-kicker">Status</span><strong>' + escapeHtml(health.status) + '</strong></div>' +
        '<div class="outlook-fact"><span class="outlook-kicker">Mode</span><strong>' + escapeHtml(health.mode) + '</strong></div>' +
        '<div class="outlook-fact"><span class="outlook-kicker">Uptime</span><strong>' + Math.floor(health.uptimeSeconds / 60) + 'm</strong></div>' +
        '</div>';
      if (health.degradedComponents && health.degradedComponents.length) {
        html += '<div class="outlook-kicker" style="margin-bottom:4px">Degraded</div>';
        health.degradedComponents.forEach(function(d) {
          html += '<div class="outlook-obligation-row" style="border-color:rgba(211,95,71,0.2)">' +
            '<strong style="color:var(--outlook-fang)">' + escapeHtml(d.component) + '</strong>' +
            '<div style="color:var(--outlook-mist);font-size:0.82rem">' + escapeHtml(d.reason) + '</div></div>';
        });
      }
    } else { html += '<p class="outlook-agent-card__lede">Health data unavailable.</p>'; }

    html += '<div class="outlook-kicker" style="margin:14px 0 6px">Recent logs (' + (logs ? logs.totalLines : 0) + ' total)</div>';
    if (logs && logs.entries && logs.entries.length) {
      html += '<div style="max-height:400px;overflow-y:auto">';
      logs.entries.slice(-30).reverse().forEach(function(e) {
        var levelColor = e.level === 'error' ? 'var(--outlook-fang)' : e.level === 'warn' ? 'var(--outlook-gold)' : 'var(--outlook-mist)';
        html += '<div style="padding:6px 0;border-bottom:1px solid rgba(110,160,117,0.08);font-size:0.78rem">' +
          '<span style="color:' + levelColor + ';font-family:var(--outlook-font-mono);font-size:0.68rem">[' + escapeHtml(e.level) + ']</span> ' +
          '<span style="color:var(--outlook-shadow);font-size:0.68rem">' + relTime(e.ts) + '</span> ' +
          '<span style="color:var(--outlook-glow)">' + escapeHtml(e.event) + '</span> ' +
          '<span style="color:var(--outlook-bone)">' + escapeHtml(truncate(e.message, 80)) + '</span></div>';
      });
      html += '</div>';
    } else { html += '<p class="outlook-agent-card__lede">No log entries.</p>'; }

    return html;
  }

  function fetchSurface(name) {
    if (cachedSurfaces[name]) return Promise.resolve(cachedSurfaces[name]);
    var url = agentEndpointBase + encodeURIComponent(selectedAgent) + '/' + name;
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { cachedSurfaces[name] = data; return data; })
      .catch(function() { return null; });
  }

  function renderTabContent(tabId, view) {
    if (!panel) return;
    var contentEl = panel.querySelector('[data-tab-content]');
    if (!contentEl) return;

    if (tabId === 'overview') {
      contentEl.innerHTML = renderOverviewTab(view);
      return;
    }

    contentEl.innerHTML = '<div class="outlook-loading">Loading...</div>';

    if (tabId === 'sessions') {
      fetchSurface('sessions').then(function(data) { contentEl.innerHTML = renderSessionsTab(data); attachTranscriptListeners(contentEl); });
    } else if (tabId === 'work') {
      fetchSurface('coding').then(function(coding) { contentEl.innerHTML = renderWorkTab(view, coding); });
    } else if (tabId === 'connections') {
      Promise.all([fetchSurface('attention'), fetchSurface('bridges'), fetchSurface('friends')])
        .then(function(results) { contentEl.innerHTML = renderConnectionsTab(results[0], results[1], results[2]); });
    } else if (tabId === 'inner') {
      fetchSurface('habits').then(function(habits) { contentEl.innerHTML = renderInnerTab(view, habits); });
    } else if (tabId === 'memory') {
      fetchSurface('memory').then(function(memory) { contentEl.innerHTML = renderMemoryTab(memory); });
    } else if (tabId === 'runtime') {
      Promise.all([
        fetch(machineEndpoint.replace('/api/machine', '/api/machine/health'), { headers: { accept: 'application/json' } }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
        fetch(machineEndpoint.replace('/api/machine', '/api/machine/logs'), { headers: { accept: 'application/json' } }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
      ]).then(function(results) { contentEl.innerHTML = renderRuntimeTab(results[0], results[1], view); });
    }
  }

  function attachTranscriptListeners(container) {
    container.querySelectorAll('.outlook-session-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        var transcriptEl = row.querySelector('.outlook-transcript');
        if (!transcriptEl) return;
        if (transcriptEl.classList.contains('is-visible')) {
          transcriptEl.classList.remove('is-visible');
          row.classList.remove('is-expanded');
          return;
        }
        var key = row.getAttribute('data-session-key');
        if (!key) return;
        row.classList.add('is-expanded');
        transcriptEl.innerHTML = '<div class="outlook-loading">Loading transcript...</div>';
        transcriptEl.classList.add('is-visible');
        var parts = key.split('/');
        var url = agentEndpointBase + encodeURIComponent(selectedAgent) + '/sessions/' +
          encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) + '/' + encodeURIComponent(parts[2]);
        fetch(url, { headers: { accept: 'application/json' } })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (data && data.messages) {
              transcriptEl.innerHTML = renderTranscript(data.messages);
            } else {
              transcriptEl.innerHTML = '<p class="outlook-agent-card__lede">Could not load transcript.</p>';
            }
          })
          .catch(function() { transcriptEl.innerHTML = '<p class="outlook-agent-card__lede">Error loading transcript.</p>'; });
      });
    });
  }

  function renderAgentPanel(view, isRefresh) {
    if (!panel || !title || !subtitle) return;
    if (!view) {
      lastAgentView = null;
      title.textContent = 'Choose an agent';
      subtitle.textContent = 'Per-agent detail appears here as soon as you focus on one thread of the organism.';
      panel.innerHTML = '<div class="outlook-agent-panel__empty"><strong>Choose an agent</strong><p>Select a visible agent from the left rail to inspect current work, obligations, senses, bridges, and inward pressure.</p></div>';
      return;
    }

    lastAgentView = view;
    title.textContent = view.agent.agentName;
    subtitle.textContent = view.agent.attention.label + ' · ' + view.activity.freshness.status + ' freshness';

    if (isRefresh && panel.querySelector('.outlook-tabs')) {
      // Preserve tab state — just refresh the current tab content
      cachedSurfaces = {};
      renderTabContent(activeTab, view);
      return;
    }

    panel.innerHTML = renderTabs() + '<div data-tab-content></div>';

    panel.querySelector('.outlook-tabs').addEventListener('click', function(e) {
      var btn = e.target.closest('.outlook-tab');
      if (!btn) return;
      activeTab = btn.getAttribute('data-tab');
      panel.querySelectorAll('.outlook-tab').forEach(function(t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === activeTab); });
      cachedSurfaces = {};
      renderTabContent(activeTab, view);
    });

    renderTabContent(activeTab, view);
  }

  function refreshMachine() {
    if (!machineEndpoint) return Promise.resolve();
    return fetch(machineEndpoint, { headers: { accept: 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(next) {
        if (!next) return;
        machineView = next;
        if (!selectedAgent && next.agents && next.agents[0]) setSelected(next.agents[0].agentName);
      })
      .catch(function() {});
  }

  function refreshAgent() {
    if (!selectedAgent || !agentEndpointBase) { renderAgentPanel(null, false); return Promise.resolve(); }
    return fetch(agentEndpointBase + encodeURIComponent(selectedAgent), { headers: { accept: 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(view) { renderAgentPanel(view, !!lastAgentView); })
      .catch(function() { renderAgentPanel(null, false); });
  }

  if (list) {
    list.addEventListener('click', function(e) {
      var target = e.target;
      if (!(target instanceof Element)) return;
      var button = target.closest('[data-agent-name]');
      if (!(button instanceof HTMLElement)) return;
      setSelected(button.getAttribute('data-agent-name') || '');
      refreshAgent();
    });
  }

  if (!selectedAgent && machineView && machineView.agents && machineView.agents[0]) {
    setSelected(machineView.agents[0].agentName);
  }

  refreshAgent();
  window.setInterval(refreshMachine, 20000);
  window.setInterval(refreshAgent, 15000);
})();
`

export function renderOutlookApp(input: RenderOutlookAppInput): string {
  /* v8 ignore next */
  emitNervesEvent({ component: "daemon", event: "daemon.outlook_render", message: "rendering outlook app", meta: {} })
  const machineView = input.machineView
  const initialAgent = firstAgentName(machineView)
  const productName = machineView?.overview.productName ?? input.machine.productName ?? OUTLOOK_PRODUCT_NAME
  const daemonMode = machineView?.overview.daemon?.mode ?? "production"
  const freshnessStatus = machineView?.overview.freshness?.status ?? input.machine.freshness?.status ?? "unknown"

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `  <title>${escapeHtml(productName)}</title>`,
    "  <meta name=\"color-scheme\" content=\"dark\" />",
    "  <meta name=\"description\" content=\"Ouro Outlook is the daemon-hosted shared orientation surface for the agents alive on this machine.\" />",
    `  <style>${APP_CSS}</style>`,
    "</head>",
    `<body data-outlook-app="${escapeHtml(productName)}" data-machine-endpoint="${escapeHtml(`${input.origin}/outlook/api/machine`)}" data-agent-endpoint-base="${escapeHtml(`${input.origin}/outlook/api/agents/`)}" data-initial-agent="${escapeHtml(initialAgent)}">`,
    "  <div class=\"outlook-shell\">",
    `    <h1 class="outlook-sr-only">${escapeHtml(productName)}</h1>`,
    "    <header class=\"outlook-nav\">",
    "      <div class=\"outlook-wordmark\">",
    "        <span class=\"outlook-orb\" aria-hidden=\"true\"></span>",
    "        <div>",
    `          <p class="outlook-product">${escapeHtml(productName)}</p>`,
    "          <p class=\"outlook-subtitle\">Regain the plot together.</p>",
    "        </div>",
    "      </div>",
    "      <div class=\"outlook-nav-meta\">",
    `        <span class="outlook-badge">${escapeHtml(daemonMode)}</span>`,
    `        <span class="outlook-badge">${escapeHtml(freshnessStatus)}</span>`,
    "      </div>",
    "    </header>",
    "    <section class=\"outlook-hero\">",
    "      <div class=\"outlook-hero__grid\">",
    "        <div>",
    "          <span class=\"outlook-kicker\">Machine Overview</span>",
    `          <h1>${escapeHtml(productName)}</h1>`,
    "          <p>Where agents regain the plot together. The daemon keeps watch, and Outlook makes the body legible: runtime truth, active obligations, coding lanes, senses, bridges, habits, and inward pressure, all on the same living field.</p>",
    "          <div class=\"outlook-footer-note\">Daemon-hosted, loopback-only, direct-read, and read-only by design.</div>",
    "        </div>",
    `        <div class="outlook-stat-grid">${renderOverviewCards(machineView, input.machine)}</div>`,
    "      </div>",
    "    </section>",
    "    <section class=\"outlook-layout\">",
    "      <aside class=\"outlook-agents-rail\">",
    "        <div class=\"outlook-section\">",
    "          <span class=\"outlook-kicker\">Visible agents</span>",
    "          <h2>Choose a thread</h2>",
    "          <div class=\"outlook-agent-list\" data-outlook-agent-list>",
    renderAgentButtons(machineView),
    "          </div>",
    "        </div>",
    "      </aside>",
    "      <main class=\"outlook-panel\">",
    "        <div class=\"outlook-section\">",
    "          <span class=\"outlook-kicker\">Machine facts</span>",
    "          <h2>Current posture</h2>",
    `          <div class="outlook-facts">${renderRuntimeFacts(machineView, input.machine)}</div>`,
    "        </div>",
    "        <div class=\"outlook-entrypoints-panel\">",
    "          <span class=\"outlook-kicker\">Entrypoints</span>",
    renderEntrypoints(machineView, input.origin),
    "        </div>",
    "        <section class=\"outlook-agent-panel\">",
    "          <span class=\"outlook-kicker\">Agent detail</span>",
    "          <h2 data-outlook-agent-title>Choose an agent</h2>",
    "          <p class=\"outlook-agent-card__lede\" data-outlook-agent-subtitle>Per-agent detail appears here as soon as you focus on one thread of the organism.</p>",
    "          <div data-outlook-agent-panel>",
    "            <div class=\"outlook-agent-panel__empty\">",
    "              <strong>Choose an agent</strong>",
    "              <p>Select a visible agent from the left rail to inspect current work, obligations, senses, bridges, and inward pressure.</p>",
    "            </div>",
    "          </div>",
    "        </section>",
    "      </main>",
    "    </section>",
    "  </div>",
    `  <script id="outlook-machine-view" type="application/json">${escapeJsonForHtml(machineView ?? null)}</script>`,
    `  <script>${APP_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n")
}
