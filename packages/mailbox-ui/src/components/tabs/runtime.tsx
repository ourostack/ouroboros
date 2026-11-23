import { useEffect, useState } from "react"
import { Badge } from "@/components/ouro/badge/badge"
import { Card } from "@/components/ouro/card/card"
import { CopyButton } from "@/components/ouro/copy-button/copy-button"
import { DescriptionList } from "@/components/ouro/description-list/description-list"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Table, type TableColumn } from "@/components/ouro/table/table"
import { Text } from "@/components/ouro/text/text"
import { fetchJson, relTime } from "../../api"
import type { MailboxAgentView, MailboxDaemonHealthDeep, MailboxLogView } from "../../contracts"

type MachineHealthResponse = MailboxDaemonHealthDeep | { status: "unavailable" }
type ProviderLaneView = NonNullable<MailboxAgentView["agent"]["providers"]>["lanes"][number]
type LogEntry = MailboxLogView["entries"][number]
type BadgeTone = "destructive" | "warning" | "success" | "secondary"

const logColumns: readonly TableColumn<LogEntry>[] = [
  {
    key: "level",
    header: "Level",
    cell: (e) => <Badge tone={e.level === "error" ? "destructive" : e.level === "warn" ? "warning" : "secondary"}>{e.level}</Badge>,
  },
  { key: "ts", header: "When", cell: (e) => relTime(e.ts) },
  { key: "event", header: "Event", cell: (e) => <span className="font-mono">{e.event}</span> },
  { key: "message", header: "Message", wrap: true, cell: (e) => e.message },
]

export function RuntimeTab({ agentName, view, refreshGeneration }: { agentName: string; view: MailboxAgentView; refreshGeneration: number }) {
  const [health, setHealth] = useState<MachineHealthResponse | null>(null)
  const [logs, setLogs] = useState<MailboxLogView | null>(null)

  const agent = view.agent
  const degraded = agent.degraded
  const freshness = agent.freshness
  const providerLanes = agent.providers?.lanes ?? []

  useEffect(() => {
    Promise.all([
      fetchJson<MachineHealthResponse>("/machine/health").then(setHealth).catch(() => null),
      fetchJson<MailboxLogView>("/machine/logs").then(setLogs).catch(() => null),
    ])
  }, [agentName, refreshGeneration])

  const machineHealth = isMachineHealthAvailable(health) ? health : null
  const degradedComponents = machineHealth?.degradedComponents ?? []
  const logEntries = logs?.entries ?? []

  return (
    <div className="space-y-8">
      {/* Agent issues — the actual degraded state */}
      {degraded.status === "degraded" && degraded.issues.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Agent issues" meta={degraded.issues.length} />
          <ItemGroup aria-label="Agent issues" variant="outline">
            {degraded.issues.map((issue, i) => (
              <Item
                key={i}
                size="sm"
                title={<Text as="span" tone="destructive"><span className="font-mono">{issue.code}</span></Text>}
                description={<span className="break-all">{issue.detail}</span>}
              />
            ))}
          </ItemGroup>
        </section>
      )}

      {/* Agent config */}
      <section className="space-y-3">
        <SectionHeader title="Agent config" />
        <DescriptionList
          items={[
            { term: "Provider lanes", details: providerLaneSummary(providerLanes) },
            { term: "Enabled", details: agent.enabled ? "yes" : "no" },
            { term: "Freshness", details: `${freshness.status}${freshness.ageMs != null ? ` (${Math.floor(freshness.ageMs / 60000)}m)` : ""}` },
          ]}
        />
      </section>

      {/* Provider lanes */}
      <section className="space-y-3">
        <SectionHeader title="Provider lanes" meta={providerLanes.length > 0 ? providerLanes.length : undefined} />
        {providerLanes.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {providerLanes.map((lane) => {
              const repairCommand = repairCommandForLane(lane)
              return (
                <Card
                  key={lane.lane}
                  size="sm"
                  headingLevel={3}
                  title={lane.lane}
                  description={providerModelLabel(lane)}
                  action={
                    <div className="flex flex-wrap gap-2">
                      <Badge tone={laneStatusTone(lane)}>{lane.status}</Badge>
                      <Badge tone={readinessTone(lane.readiness.status)}>{lane.readiness.status}</Badge>
                    </div>
                  }
                >
                  <div className="space-y-1">
                    <Text size="sm">source: {lane.source}</Text>
                    <Text size="sm">readiness: {readinessLabel(lane.readiness)}</Text>
                    {lane.readiness.attempts !== undefined && <Text size="sm">attempts: {lane.readiness.attempts}</Text>}
                    {lane.readiness.checkedAt && <Text size="sm">checked: {relTime(lane.readiness.checkedAt)}</Text>}
                    <Text size="sm">credentials: {credentialLabel(lane.credential)}</Text>
                    {lane.credential.revision && <Text size="sm">revision: {lane.credential.revision}</Text>}
                    {laneReason(lane) && <Text size="sm">reason: {laneReason(lane)}</Text>}
                    {repairCommand && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Text size="sm" tone="destructive" className="min-w-0 break-all">repair: {repairCommand}</Text>
                        <CopyButton value={repairCommand} label="Copy repair command" hideLabel variant="plain" />
                      </div>
                    )}
                    {lane.warnings.map((warning, i) => (
                      <Text key={i} size="sm" tone="warning" className="break-words">warning: {warning}</Text>
                    ))}
                  </div>
                </Card>
              )
            })}
          </div>
        ) : (
          <Empty title="No provider lane data loaded." variant="plain" align="start" />
        )}
      </section>

      {/* Daemon health */}
      <section className="space-y-3">
        <SectionHeader title="Daemon health" />
        {machineHealth ? (
          <>
            <DescriptionList
              items={[
                { term: "Status", details: machineHealth.status },
                { term: "Mode", details: machineHealth.mode },
                { term: "Uptime", details: `${Math.floor(machineHealth.uptimeSeconds / 60)}m` },
              ]}
            />
            {degradedComponents.length > 0 && (
              <ItemGroup label="Degraded components" variant="outline">
                {degradedComponents.map((d, i) => (
                  <Item
                    key={i}
                    size="sm"
                    title={<Text as="span" tone="destructive">{d.component}</Text>}
                    description={d.reason}
                  />
                ))}
              </ItemGroup>
            )}
          </>
        ) : (
          <Empty
            title="No health file found."
            description="This is normal when not running under the daemon."
            variant="plain"
            align="start"
          />
        )}
      </section>

      {/* Logs */}
      <section className="space-y-3">
        <SectionHeader title="Recent logs" meta={`${logs?.totalLines ?? 0} total`} />
        {logEntries.length > 0 ? (
          <Table
            caption="Recent logs"
            hideCaption
            dense
            stickyHeader
            className="max-h-96"
            columns={logColumns}
            rows={[...logEntries].reverse().slice(0, 50)}
            rowKey={(_, i) => i}
          />
        ) : (
          <Empty title="No log entries." variant="plain" align="start" />
        )}
      </section>
    </div>
  )
}

function providerLaneSummary(lanes: ProviderLaneView[]): string {
  if (lanes.length === 0) return "none"
  const configured = lanes.filter((lane) => lane.status === "configured").length
  return `${configured}/${lanes.length} configured`
}

function providerModelLabel(lane: ProviderLaneView): string {
  if (lane.status === "unconfigured") return "unconfigured"
  return `${lane.provider} / ${lane.model}`
}

function readinessLabel(readiness: ProviderLaneView["readiness"]): string {
  if (readiness.status === "failed") return readiness.error ? `failed: ${readiness.error}` : "failed"
  if (readiness.status === "stale") return readiness.reason ? `stale: ${readiness.reason}` : "stale"
  if (readiness.status === "unknown") return readiness.reason ? `unknown: ${readiness.reason}` : "unknown"
  return readiness.status
}

function credentialLabel(credential: ProviderLaneView["credential"]): string {
  if (credential.status === "present") return credential.source ?? "vault"
  if (credential.status === "invalid-pool") return "vault unavailable"
  return "missing"
}

function repairCommandForLane(lane: ProviderLaneView): string | undefined {
  if (lane.status === "unconfigured") return lane.repairCommand
  return lane.credential.repairCommand
}

function laneReason(lane: ProviderLaneView): string | undefined {
  return lane.status === "unconfigured" ? lane.reason : lane.readiness.reason
}

function laneStatusTone(lane: ProviderLaneView): BadgeTone {
  return lane.status === "configured" ? "success" : "warning"
}

function readinessTone(status: ProviderLaneView["readiness"]["status"]): BadgeTone {
  if (status === "ready") return "success"
  if (status === "failed") return "destructive"
  if (status === "stale") return "warning"
  return "secondary"
}

function isMachineHealthAvailable(health: MachineHealthResponse | null): health is MailboxDaemonHealthDeep {
  return Boolean(health && "degradedComponents" in health)
}
