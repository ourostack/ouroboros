import { useEffect, useRef, useState } from "react"
import { fetchJson } from "../api"
import { Badge } from "../catalyst/badge"
import type { ShepherdSupervisionEvent, ShepherdSupervisionView } from "../contracts"
import { shepherdInspectionCommand, shepherdRetirementCommand, SHEPHERD_ALPHA_AUTOMATION_WARNING } from "../contracts"

interface SupervisionProps {
  agents: string[]
  agentName: string | null
  focus?: string
  refreshGeneration: number
  onSelectOwner(agent: string | null): void
}
const eventLabels: Record<ShepherdSupervisionEvent["kind"], string> = {
  observation: "Observation", judgment: "Judgment", input_admitted: "Input admitted", input_unknown: "Input unknown",
  legacy_input_reported: "Legacy input report (unqualified)",
  notification_queued: "Notification queued", notification_delivered: "Notification transport acceptance",
  notification_unknown: "Notification unknown", recovery: "Acknowledged recovery",
}
function age(at: string | null, now: number): number | null {
  const ms = at === null ? NaN : now - Date.parse(at)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}
function ageLabel(at: string | null, now: number): string {
  const ms = age(at, now)
  return ms === null ? "unknown" : `${Math.floor(ms / 1000)}s`
}
function fresh(at: string | null, now: number): boolean {
  const ms = age(at, now)
  return ms !== null && ms <= 30_000
}
const panel = "rounded-xl bg-ouro-void/50 p-4 ring-1 ring-ouro-moss/25"

function LocalCommand({ command, label }: { command: string | null; label: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null)
  if (!command) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setResult("copied")
    } catch { setResult("failed") }
  }
  return <div className="min-w-0 space-y-1">
    <code className="block select-text break-all rounded-md bg-ouro-void p-2 text-xs">{command}</code>
    <button type="button" onClick={() => { void copy() }} className="text-xs text-ouro-glow underline">Copy {label} command</button>
    {result === "copied" && <span role="status" className="ml-2 text-xs text-ouro-mist">Copied for local execution; nothing was run.</span>}
    {result === "failed" && <p role="alert" className="text-xs text-ouro-gold">Copy failed. Select the command text and copy it manually.</p>}
  </div>
}

export function Supervision({ agents, agentName, focus, refreshGeneration, onSelectOwner }: SupervisionProps) {
  const [data, setData] = useState<ShepherdSupervisionView | null>(null)
  const [error, setError] = useState<{ agent: string; message: string } | null>(null)
  const [now, setNow] = useState(Date.now)
  const reload = useRef<(() => void) | null>(null)
  const lastGeneration = useRef(refreshGeneration)

  useEffect(() => {
    if (!agentName) { reload.current = null; return }
    const owner = agentName
    let active = true
    let inFlight = false
    let queued = false
    let controller: AbortController | null = null
    const load = async (): Promise<void> => {
      if (!active) return
      if (inFlight) { queued = true; return }
      inFlight = true
      controller = new AbortController()
      try {
        const snapshot = await fetchJson<ShepherdSupervisionView>(`/agents/${encodeURIComponent(owner)}/supervision`, { signal: controller.signal })
        if (!active) return
        if (snapshot.agentName !== owner) throw new Error("the observation belongs to another agent")
        if (snapshot.schemaVersion !== 1) throw new Error("unsupported observation schema")
        setData(snapshot)
        setError(null)
        setNow(Date.now())
      } catch (failure) {
        if (active && !controller.signal.aborted) setError({ agent: owner, message: failure instanceof Error ? failure.message : String(failure) })
      } finally {
        inFlight = false
        if (active && queued) { queued = false; void load() }
      }
    }
    const request = () => { void load() }
    reload.current = request
    request()
    const poll = window.setInterval(() => { if (document.visibilityState !== "hidden") request() }, 5_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    const visible = () => {
      setNow(Date.now())
      if (document.visibilityState !== "hidden") request()
    }
    document.addEventListener("visibilitychange", visible)
    return () => {
      active = false
      controller?.abort()
      window.clearInterval(poll)
      window.clearInterval(clock)
      document.removeEventListener("visibilitychange", visible)
      if (reload.current === request) reload.current = null
    }
  }, [agentName])

  useEffect(() => {
    if (lastGeneration.current === refreshGeneration) return
    lastGeneration.current = refreshGeneration
    reload.current?.()
  }, [refreshGeneration])

  const view = data?.agentName === agentName ? data : null
  const currentError = error?.agent === agentName ? error.message : null
  const current = view?.freshness.status === "fresh" && fresh(view.freshness.observedAt, now)
  const status = !view || view.freshness.status === "unknown" || age(view.freshness.observedAt, now) === null
    ? "unknown" : current ? "fresh" : "stale"
  const rows = view?.sessions.items.map(row => ({
    ...row,
    activity: current && row.freshness.status === "fresh" && fresh(row.observedAt, now) ? row.activity : "unknown" as const,
    authority: current && fresh(row.observedAt, now) ? row.authority : "unknown" as const,
    capability: current && fresh(row.observedAt, now) ? row.capability : "unknown" as const,
  })) ?? []
  const counts = view?.counts ? { working: 0, idle: 0, shell: 0, unknown: 0 } : null
  if (counts) for (const row of rows) counts[row.activity] += 1
  const held = view?.custody.claims.items.filter(claim => (claim.state === "unknown" || claim.state === "claimed") && !claim.retired) ?? []

  return (
    <div className="space-y-6 text-ouro-bone">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Supervision</h1>
          <p className="mt-2 max-w-2xl text-sm text-ouro-mist">
            What Shepherd can observe, why it acted or withheld input, and what still needs the owner.
            Quiet terminals and judgments are not proof of merge, publication or deployment.
          </p>
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-ouro-mist">
          Owning Ouro agent
          <select aria-label="Owning Ouro agent" value={agentName ?? ""} onChange={event => onSelectOwner(event.target.value || null)}
            className="max-w-full rounded-lg border border-ouro-moss/40 bg-ouro-deep px-3 py-2 text-ouro-bone">
            <option value="">Choose an owner</option>
            {agentName && !agents.includes(agentName) && <option value={agentName}>{agentName} (not in machine inventory)</option>}
            {agents.map(agent => <option key={agent} value={agent}>{agent}</option>)}
          </select>
        </label>
      </header>
      <aside className={`${panel} text-sm text-ouro-gold`} aria-label="Alpha automation boundary">
        <p className="font-semibold">Alpha automation boundary</p>
        <p className="mt-1">{SHEPHERD_ALPHA_AUTOMATION_WARNING}</p>
      </aside>

      {!agentName ? <p className={panel}>Choose an owning Ouro agent to inspect its terminal supervision. No fleet counts are available until an owner is selected.</p> : (
        <>
          {currentError && <div role="alert" className={`${panel} text-ouro-gold`}>
            Could not load supervision for {agentName}: {currentError}.
            {view && <> Showing the last successful observation for {agentName}; its age continues to increase.</>}
            <button type="button" className="ml-2 underline" onClick={() => reload.current?.()}>Retry observation</button>
          </div>}
          {!view && !currentError && <p role="status">Loading supervision for {agentName}...</p>}
          {view && <>
            <section className={panel} aria-label="Observation health">
              <div className="flex flex-wrap items-center gap-3">
                <Badge color={status === "fresh" ? "lime" : "yellow"}><span data-testid="supervision-freshness">{status} observation</span></Badge>
                <Badge color={view.health === "ok" ? "zinc" : "yellow"}>{view.health === "ok" ? "Sources readable" : "Sources degraded"}</Badge>
                <p className="text-sm">Observation age: {ageLabel(view.freshness.observedAt, now)}</p>
                <button type="button" onClick={() => reload.current?.()} className="text-sm text-ouro-glow underline">Refresh observation</button>
              </div>
              {view.freshness.observedAt && <p className="mt-2 break-words font-mono text-xs text-ouro-mist">
                Observed at <time dateTime={view.freshness.observedAt}>{view.freshness.observedAt}</time>. Reading this page does not refresh the observation.
              </p>}
              <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ouro-mist">
                {Object.entries(view.sourceHealth).map(([source, health]) => <div key={source} className="flex gap-1"><dt>{source}:</dt><dd>{health}</dd></div>)}
              </dl>
              {view.sourceErrors.length > 0 && <ul className="mt-3 space-y-1 text-sm text-ouro-gold">
                {view.sourceErrors.map((issue, index) => <li key={`${issue.source}:${issue.code}:${index}`} className="break-words">{issue.source}: {issue.detail}</li>)}
              </ul>}
            </section>
            <section aria-label="Terminal counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(["working", "idle", "shell", "unknown"] as const).map(activity => <div key={activity} className={panel}>
                <p className="text-xs uppercase tracking-widest text-ouro-mist">{activity}</p>
                <p data-testid={`supervision-count-${activity}`} className="mt-1 text-2xl tabular-nums">{counts?.[activity] ?? "Unknown"}</p>
              </div>)}
            </section>
            <p className="text-sm text-ouro-mist">Showing {rows.length} of {view.sessions.totalCount ?? "unknown"} terminals.
              {view.sessions.truncated && " Inventory is truncated."} Counts above describe only the displayed rows.</p>
            <section aria-label="Supervised terminals" className="grid min-w-0 gap-4 xl:grid-cols-2">
              {rows.map(row => {
                const key = `${row.host}:${row.session}`
                const timeline = view.timeline.items.filter(event => event.host === row.host && event.session === row.session)
                return <article key={key} className={`${panel} min-w-0 space-y-3`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="min-w-0 break-words text-lg font-semibold">{row.label}</h2>
                    <Badge color={row.activity === "working" ? "lime" : row.activity === "unknown" ? "yellow" : "zinc"}>{row.activity}</Badge>
                  </div>
                  <dl className="space-y-1 break-words text-sm text-ouro-mist">
                    <div><dt className="inline">Terminal: </dt><dd className="inline font-mono">{row.host} / {row.session}</dd></div>
                    <div><dt className="inline">Harness: </dt><dd className="inline">{row.harness ?? "Unknown / no identified coding harness"}</dd></div>
                    <div><dt className="inline">Project: </dt><dd className="inline font-mono">{row.project ?? "Unknown"}</dd></div>
                    <div><dt className="inline">Process instance: </dt><dd className="inline font-mono">{row.instance ?? "Unknown"}</dd></div>
                    <div><dt className="inline">Last observed: </dt><dd className="inline">{ageLabel(row.observedAt, now)} ago</dd></div>
                  </dl>
                  <p className="text-sm">Stored mandate / pause state: {row.authority}. Guarded input: {row.capability}.</p>
                  <p className="break-words text-sm text-ouro-gold">Stored policy assessment, not an enforced dispatch decision: {row.withheldReason ?? "Unknown."}</p>
                  <p className="text-sm">Last recorded judgment: <span>{row.lastDecisionLabel ?? "None recorded"}</span></p>
                  <p className="break-words text-sm text-ouro-mist">
                    Last recorded action: {row.lastAction === "respond" ? "Reported terminal response" : row.lastAction === "let_through" ? "Let through without a response" : "None recorded"}.
                    {row.lastReason && <> {row.lastReason}</>}
                    {row.lastActionAt && <> <time dateTime={row.lastActionAt}>{row.lastActionAt}</time></>}
                  </p>
                  <a className="inline-block text-xs text-ouro-glow underline" href={`#/supervision/${encodeURIComponent(agentName)}/${encodeURIComponent(key)}`}>Link to this terminal</a>
                  <details open={focus === key || undefined} className="border-t border-ouro-moss/25 pt-3">
                    <summary className="cursor-pointer text-sm text-ouro-glow">Timeline for {row.label}</summary>
                    {timeline.length === 0 && <p className="mt-2 text-sm text-ouro-mist">No retained events for this terminal.</p>}
                    <ol className="mt-3 space-y-3">
                      {timeline.map(event => <li key={event.id} className="break-words text-sm">
                        <p>{eventLabels[event.kind]}: {event.summary}</p>
                        <p className="mt-1 font-mono text-xs text-ouro-mist"><time dateTime={event.at}>{event.at}</time>
                          {" | "}{event.instance ? `instance ${event.instance}` : "instance not recorded"}</p>
                      </li>)}
                    </ol>
                  </details>
                </article>
              })}
              {rows.length === 0 && <p className={panel}>{view.counts === null ? "Terminal inventory is unavailable, not empty." : "No terminals were present in this observation."}</p>}
            </section>
            <section className={panel} aria-label="Custody and held inputs">
              <h2 className="text-lg font-semibold">Replay barriers and unknown inputs</h2>
              <p className="mt-2 text-sm text-ouro-gold">Unknown effects remain held: do not retry blindly. Owner administration is local-only; this browser cannot resolve or retry claims.</p>
              <div className="mt-3">
                <LocalCommand key={agentName} command={shepherdInspectionCommand(agentName)} label="status" />
              </div>
              <p className="mt-2 text-xs text-ouro-mist">Run commands locally as the existing owner. Local administration is same-UID authority, not proof of human presence.
                {" "}Read current status and inspect the exact claim before changing anything. A stale revision will be rejected.</p>
              <p className="mt-2 text-xs text-ouro-mist">Custody revision: {view.custody.revision ?? "unknown"}.
                {" "}Storage: {view.custody.bytes === null ? "unknown" : `${view.custody.bytes.toLocaleString()} bytes`} ({view.custody.capacity}).
                {" "}Showing {view.custody.claims.items.length} of {view.custody.claims.totalCount ?? "unknown"} retained barriers.
                {view.custody.claims.truncated && " Custody inventory is truncated."}</p>
              {held.map(claim => <div key={claim.id} className="mt-3 space-y-1 break-words border-t border-ouro-moss/25 pt-3 text-sm">
                <p>Original state: {claim.state} | {claim.host} / {claim.session}</p>
                <p className="break-all font-mono text-xs">{claim.id}</p>
                <p className="text-ouro-mist">{claim.reason ?? "No outcome evidence is recorded."} Acknowledgments in the timeline do not rewrite the original state.</p>
                <LocalCommand command={shepherdInspectionCommand(agentName, claim.id)} label="inspection" />
                <details className="pt-2">
                  <summary className="cursor-pointer text-xs text-ouro-glow">Local recovery after terminal retirement</summary>
                  <p className="my-2 text-xs text-ouro-mist">The entire terminal must be absent from a strict host inventory.
                    {" "}A different foreground process is not proof of retirement. This command never confirms delivery or retries input.
                    {" "}Confirmed-delivery recovery remains unsupported until native receipt lookup is qualified.</p>
                  <LocalCommand key={`${claim.id}:${view.custody.revision}`} command={shepherdRetirementCommand(agentName, claim.id, view.custody.revision)} label="retirement" />
                  {view.custody.revision === null && <p className="text-xs text-ouro-gold">No retirement command is available until a custody revision is known.</p>}
                </details>
              </div>)}
              {view.custody.claims.totalCount === null && <p className="mt-3 text-sm">Custody availability is unknown; zero held inputs cannot be established.</p>}
            </section>
            <details className={panel}>
              <summary className="cursor-pointer text-sm text-ouro-glow">All retained events, including closed terminals</summary>
              <ol className="mt-3 space-y-3">
                {view.timeline.items.map(event => <li key={event.id} className="break-words text-sm">
                  <p>{event.host} / {event.session}: {eventLabels[event.kind]}: {event.summary}</p>
                  <p className="mt-1 font-mono text-xs text-ouro-mist">
                    <time dateTime={event.at}>{event.at}</time>{" | "}{event.instance ?? "instance not recorded"}
                  </p>
                </li>)}
              </ol>
            </details>
            <p className="text-xs text-ouro-mist">Retained timeline: {view.timeline.items.length} of {view.timeline.totalCount ?? "unknown"} events.
              {view.timeline.truncated && " History is truncated; absence from this view is not proof that an event never occurred."}</p>
          </>}
        </>
      )}
    </div>
  )
}
