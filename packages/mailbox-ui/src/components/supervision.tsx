import { useEffect, useRef, useState } from "react"
import { fetchJson } from "../api"
import { Badge } from "./status-badge"
import { Alert } from "@/components/ouro/alert/alert"
import { Button } from "@/components/ouro/button/button"
import { Card } from "@/components/ouro/card/card"
import { Collapsible } from "@/components/ouro/collapsible/collapsible"
import { DescriptionList } from "@/components/ouro/description-list/description-list"
import { Empty } from "@/components/ouro/empty/empty"
import { PageHeader } from "@/components/ouro/page-header/page-header"
import { Separator } from "@/components/ouro/separator/separator"
import { Text } from "@/components/ouro/text/text"
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
    <code className="block select-text break-all rounded-md bg-ouro-void p-2 font-mono text-xs">{command}</code>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="plain" size="sm" onClick={() => { void copy() }}>Copy {label} command</Button>
      {result === "copied" && <Text as="span" size="sm" tone="muted" role="status">Copied for local execution; nothing was run.</Text>}
    </div>
    {result === "failed" && <Alert tone="warning" title="Copy failed." description="Select the command text and copy it manually." />}
  </div>
}

function EventList({ events, withTerminal }: { events: ShepherdSupervisionEvent[]; withTerminal?: boolean }) {
  return <ol className="mt-3 space-y-3">
    {events.map(event => <li key={event.id} className="break-words text-sm">
      <p>{withTerminal && <>{event.host} / {event.session}: </>}{eventLabels[event.kind]}: {event.summary}</p>
      <p className="mt-1 font-mono text-xs text-ouro-mist"><time dateTime={event.at}>{event.at}</time>
        {" | "}{withTerminal ? event.instance ?? "instance not recorded" : event.instance ? `instance ${event.instance}` : "instance not recorded"}</p>
    </li>)}
  </ol>
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
    <div className="space-y-6">
      <PageHeader
        title="Supervision"
        description={<>
          What Shepherd can observe, why it acted or withheld input, and what still needs the owner.
          Quiet terminals and judgments are not proof of merge, publication or deployment.
        </>}
        actions={<label className="flex min-w-0 flex-col gap-1 text-sm text-ouro-mist">
          Owning Ouro agent
          <select aria-label="Owning Ouro agent" value={agentName ?? ""} onChange={event => onSelectOwner(event.target.value || null)}
            className="max-w-full rounded-lg border border-ouro-moss/40 bg-ouro-deep px-3 py-2 text-ouro-bone">
            <option value="">Choose an owner</option>
            {agentName && !agents.includes(agentName) && <option value={agentName}>{agentName} (not in machine inventory)</option>}
            {agents.map(agent => <option key={agent} value={agent}>{agent}</option>)}
          </select>
        </label>}
      />
      {/* Information, not an alert: a warning tone would make it a second role="alert" beside a real failure. */}
      <Alert tone="primary" aria-label="Alpha automation boundary" title="Alpha automation boundary" description={SHEPHERD_ALPHA_AUTOMATION_WARNING} />

      {!agentName ? <Empty
        title="No owner selected"
        description="Choose an owning Ouro agent to inspect its terminal supervision. No fleet counts are available until an owner is selected."
      /> : (
        <>
          {currentError && <Alert
            tone="warning"
            title={`Could not load supervision for ${agentName}: ${currentError}.`}
            description={view ? `Showing the last successful observation for ${agentName}; its age continues to increase.` : undefined}
            action={<Button size="sm" variant="outline" onClick={() => reload.current?.()}>Retry observation</Button>}
          />}
          {!view && !currentError && <Text role="status" tone="muted">Loading supervision for {agentName}...</Text>}
          {view && <>
            <Card as="section" aria-label="Observation health">
              <div className="flex flex-wrap items-center gap-3">
                <Badge color={status === "fresh" ? "lime" : "yellow"}><span data-testid="supervision-freshness">{status} observation</span></Badge>
                <Badge color={view.health === "ok" ? "zinc" : "yellow"}>{view.health === "ok" ? "Sources readable" : "Sources degraded"}</Badge>
                <Text as="span" size="sm">Observation age: {ageLabel(view.freshness.observedAt, now)}</Text>
                <Button variant="plain" size="sm" onClick={() => reload.current?.()}>Refresh observation</Button>
              </div>
              {view.freshness.observedAt && <Text size="sm" tone="muted" className="mt-2 break-words">
                Observed at <time className="font-mono" dateTime={view.freshness.observedAt}>{view.freshness.observedAt}</time>. Reading this page does not refresh the observation.
              </Text>}
              <DescriptionList
                className="mt-3"
                items={Object.entries(view.sourceHealth).map(([source, health]) => ({ term: source, details: health }))}
              />
              {view.sourceErrors.length > 0 && <ul className="mt-3 space-y-1">
                {view.sourceErrors.map((issue, index) => <li key={`${issue.source}:${issue.code}:${index}`}>
                  <Text size="sm" tone="warning" className="break-words">{issue.source}: {issue.detail}</Text>
                </li>)}
              </ul>}
            </Card>
            <section aria-label="Terminal counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(["working", "idle", "shell", "unknown"] as const).map(activity => <Card key={activity} size="sm">
                <p className="text-xs uppercase tracking-widest text-ouro-mist">{activity}</p>
                <p data-testid={`supervision-count-${activity}`} className="mt-1 text-2xl tabular-nums">{counts?.[activity] ?? "Unknown"}</p>
              </Card>)}
            </section>
            <Text size="sm" tone="muted">Showing {rows.length} of {view.sessions.totalCount ?? "unknown"} terminals.
              {view.sessions.truncated && " Inventory is truncated."} Counts above describe only the displayed rows.</Text>
            <section aria-label="Supervised terminals" className="grid min-w-0 gap-4 xl:grid-cols-2">
              {rows.map(row => {
                const key = `${row.host}:${row.session}`
                const timeline = view.timeline.items.filter(event => event.host === row.host && event.session === row.session)
                return <Card
                  key={key}
                  as="article"
                  headingLevel={2}
                  title={row.label}
                  action={<Badge color={row.activity === "working" ? "lime" : row.activity === "unknown" ? "yellow" : "zinc"}>{row.activity}</Badge>}
                  className="min-w-0"
                >
                  <div className="space-y-3">
                    <DescriptionList
                      items={[
                        { term: "Terminal", details: <span className="font-mono">{row.host} / {row.session}</span> },
                        { term: "Harness", details: row.harness ?? "Unknown / no identified coding harness" },
                        { term: "Project", details: <span className="font-mono">{row.project ?? "Unknown"}</span> },
                        { term: "Process instance", details: <span className="font-mono">{row.instance ?? "Unknown"}</span> },
                        { term: "Last observed", details: `${ageLabel(row.observedAt, now)} ago` },
                      ]}
                    />
                    <Text size="sm">Stored mandate / pause state: {row.authority}. Guarded input: {row.capability}.</Text>
                    <Text size="sm" tone="warning" className="break-words">Stored policy assessment, not an enforced dispatch decision: {row.withheldReason ?? "Unknown."}</Text>
                    <Text size="sm">Last recorded judgment: <span>{row.lastDecisionLabel ?? "None recorded"}</span></Text>
                    <Text size="sm" tone="muted" className="break-words">
                      Last recorded action: {row.lastAction === "respond" ? "Reported terminal response" : row.lastAction === "let_through" ? "Let through without a response" : "None recorded"}.
                      {row.lastReason && <> {row.lastReason}</>}
                      {row.lastActionAt && <> <time dateTime={row.lastActionAt}>{row.lastActionAt}</time></>}
                    </Text>
                    <a className="inline-block text-xs text-ouro-glow underline" href={`#/supervision/${encodeURIComponent(agentName)}/${encodeURIComponent(key)}`}>Link to this terminal</a>
                    {/* Native details, not Collapsible: a link to this terminal opens it through `open` on the first render. */}
                    <details open={focus === key || undefined} className="border-t border-ouro-moss/25 pt-3">
                      <summary className="cursor-pointer text-sm text-ouro-glow">Timeline for {row.label}</summary>
                      {timeline.length === 0 && <Text size="sm" tone="muted" className="mt-2">No retained events for this terminal.</Text>}
                      <EventList events={timeline} />
                    </details>
                  </div>
                </Card>
              })}
              {rows.length === 0 && <Empty title={view.counts === null ? "Terminal inventory is unavailable, not empty." : "No terminals were present in this observation."} />}
            </section>
            <Card as="section" aria-label="Custody and held inputs" headingLevel={2} title="Replay barriers and unknown inputs">
              <Text size="sm" tone="warning">Unknown effects remain held: do not retry blindly. Owner administration is local-only; this browser cannot resolve or retry claims.</Text>
              <div className="mt-3">
                <LocalCommand key={agentName} command={shepherdInspectionCommand(agentName)} label="status" />
              </div>
              <Text size="sm" tone="muted" className="mt-2">Run commands locally as the existing owner. Local administration is same-UID authority, not proof of human presence.
                {" "}Read current status and inspect the exact claim before changing anything. A stale revision will be rejected.</Text>
              <Text size="sm" tone="muted" className="mt-2">Custody revision: {view.custody.revision ?? "unknown"}.
                {" "}Storage: {view.custody.bytes === null ? "unknown" : `${view.custody.bytes.toLocaleString()} bytes`} ({view.custody.capacity}).
                {" "}Showing {view.custody.claims.items.length} of {view.custody.claims.totalCount ?? "unknown"} retained barriers.
                {view.custody.claims.truncated && " Custody inventory is truncated."}</Text>
              {held.map(claim => <div key={claim.id} className="mt-3 space-y-1 break-words text-sm">
                <Separator className="mb-3" />
                <p>Original state: {claim.state} | {claim.host} / {claim.session}</p>
                <p className="break-all font-mono text-xs">{claim.id}</p>
                <Text size="sm" tone="muted">{claim.reason ?? "No outcome evidence is recorded."} Acknowledgments in the timeline do not rewrite the original state.</Text>
                <LocalCommand command={shepherdInspectionCommand(agentName, claim.id)} label="inspection" />
                <Collapsible title="Local recovery after terminal retirement" className="pt-2">
                  <Text size="sm" tone="muted" className="my-2">The entire terminal must be absent from a strict host inventory.
                    {" "}A different foreground process is not proof of retirement. This command never confirms delivery or retries input.
                    {" "}Confirmed-delivery recovery remains unsupported until native receipt lookup is qualified.</Text>
                  <LocalCommand key={`${claim.id}:${view.custody.revision}`} command={shepherdRetirementCommand(agentName, claim.id, view.custody.revision)} label="retirement" />
                  {view.custody.revision === null && <Text size="sm" tone="warning">No retirement command is available until a custody revision is known.</Text>}
                </Collapsible>
              </div>)}
              {view.custody.claims.totalCount === null && <Text size="sm" className="mt-3">Custody availability is unknown; zero held inputs cannot be established.</Text>}
            </Card>
            <Card size="sm">
              <Collapsible title="All retained events, including closed terminals">
                <EventList events={view.timeline.items} withTerminal />
              </Collapsible>
            </Card>
            <Text size="sm" tone="muted">Retained timeline: {view.timeline.items.length} of {view.timeline.totalCount ?? "unknown"} events.
              {view.timeline.truncated && " History is truncated; absence from this view is not proof that an event never occurred."}</Text>
          </>}
        </>
      )}
    </div>
  )
}
