import { useEffect, useState, type ReactNode } from "react"
import { Badge as OuroBadge } from "@/components/ouro/badge/badge"
import { Button } from "@/components/ouro/button/button"
import { Card } from "@/components/ouro/card/card"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import { Badge } from "../status-badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate, type TabId } from "../../navigation"
import type {
  MailboxAgentView,
  MailboxChangesView,
  MailboxCodingDeep,
  MailboxContinuityView,
  MailboxDeskPrefs,
  MailboxNeedsMeView,
  MailboxOrientationView,
} from "../../contracts"
import { CenterOfGravity } from "./overview/center-of-gravity"
import { ContinuityCards } from "./overview/continuity-cards"
import { NeedsMeSection } from "./overview/needs-me"
import { OrientationCard } from "./overview/orientation-card"

const ACTIVE_CODING_STATUSES = new Set<string>(["spawning", "running", "waiting_input", "stalled"])

export function OverviewTab({ view, deskPrefs, refreshGeneration }: { view: MailboxAgentView; deskPrefs?: MailboxDeskPrefs | null; refreshGeneration: number }) {
  const nav = useNavigate()
  const [needsMe, setNeedsMe] = useState<MailboxNeedsMeView | null>(null)
  const [codingDeep, setCodingDeep] = useState<MailboxCodingDeep | null>(null)
  const [continuity, setContinuity] = useState<MailboxContinuityView | null>(null)
  const [orientation, setOrientation] = useState<MailboxOrientationView | null>(null)
  const [changes, setChanges] = useState<MailboxChangesView | null>(null)
  const agent = view.agent
  const work = view.work
  const inner = view.inner
  const activity = view.activity
  const tasks = work.tasks
  const obligations = work.obligations
  const sessions = work.sessions
  const coding = work.coding
  const senses = agent.senses
  const bridges = work.bridges

  useEffect(() => {
    fetchJson<MailboxNeedsMeView>(`/agents/${encodeURIComponent(agent.agentName)}/needs-me`).then(setNeedsMe)
    fetchJson<MailboxCodingDeep>(`/agents/${encodeURIComponent(agent.agentName)}/coding`).then(setCodingDeep)
    fetchJson<MailboxContinuityView>(`/agents/${encodeURIComponent(agent.agentName)}/continuity`).then(setContinuity).catch(() => {})
    fetchJson<MailboxOrientationView>(`/agents/${encodeURIComponent(agent.agentName)}/orientation`).then(setOrientation).catch(() => {})
    fetchJson<MailboxChangesView>(`/agents/${encodeURIComponent(agent.agentName)}/changes`).then(setChanges).catch(() => {})
  }, [agent.agentName, refreshGeneration])

  const constellations = deskPrefs?.pinnedConstellations ?? []
  const activeCoding = codingDeep?.items.filter((c) => ACTIVE_CODING_STATUSES.has(c.status)) ?? []
  const fulfilled = obligations.items.filter((o) => o.status === "fulfilled")

  return (
    <div className="space-y-6">
      {needsMe && needsMe.items.length > 0 && (
        <NeedsMeSection needsMe={needsMe} setNeedsMe={setNeedsMe} agentName={agent.agentName} nav={nav} />
      )}

      {/* Agent-written, editable via mailbox-prefs.json */}
      {deskPrefs?.carrying && (
        <Card headingLevel={2} title="What I'm carrying">
          <Text size="sm">{deskPrefs.carrying}</Text>
        </Card>
      )}

      {constellations.length > 0 && (
        <Section title="Pinned threads">
          <ItemGroup variant="outline" aria-label="Pinned threads">
            {constellations.map((c, i) => (
              <Item
                key={i}
                title={c.label}
                description={
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {c.friendIds.map((f) => (
                      <ThreadLink key={f} onClick={() => nav({ tab: "sessions" })}>friend:{f.slice(0, 8)}…</ThreadLink>
                    ))}
                    {c.taskRefs.map((t) => (
                      <ThreadLink key={t} onClick={() => nav({ tab: "work" })}>task:{t}</ThreadLink>
                    ))}
                    {c.bridgeIds.map((b) => (
                      <ThreadLink key={b} onClick={() => nav({ tab: "connections", focus: b })}>bridge:{b.slice(0, 8)}…</ThreadLink>
                    ))}
                  </span>
                }
              />
            ))}
          </ItemGroup>
        </Section>
      )}

      <CenterOfGravity view={view} nav={nav} />

      <OrientationCard orientation={orientation} nav={nav} />

      {/* What changed: cross-session drift */}
      {changes && changes.changeCount > 0 && (
        <Section title="What changed" meta={changes.changeCount}>
          {changes.snapshotAge && <Text size="sm" tone="muted">Since {relTime(changes.snapshotAge)}</Text>}
          <ItemGroup aria-label="What changed">
            {changes.items.slice(0, 8).map((c, i) => (
              <Item
                key={i}
                size="sm"
                title={<span className="block truncate">{c.summary}</span>}
                actions={<Badge color={c.kind.includes("status") ? "yellow" : "zinc"}>{c.kind.replace(/_/g, " ")}</Badge>}
              />
            ))}
          </ItemGroup>
          {changes.items.length > 8 && (
            <Text size="sm" tone="muted">+{changes.items.length - 8} more changes</Text>
          )}
        </Section>
      )}

      <ContinuityCards continuity={continuity} />

      {/* Meters */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Meter label="Tasks" value={tasks.liveCount} sub={`${tasks.blockedCount} blocked`} onClick={() => nav({ tab: "work" })} />
        <Meter label="Obligations" value={obligations.openCount} sub={`${sessions.liveCount} sessions`} onClick={() => nav({ tab: "work" })} />
        <Meter label="Coding" value={coding.activeCount} sub={`${coding.blockedCount} blocked`} onClick={() => nav({ tab: "work" })} />
        <Meter label="Private Runtime" value={inner.status} sub={truncate(inner.summary ?? "", 30)} onClick={() => nav({ tab: "inner" })} />
      </div>

      {activeCoding.length > 0 && (
        <Section title="Active coding" meta={activeCoding.length}>
          <ItemGroup variant="outline" aria-label="Active coding">
            {activeCoding.map((c) => (
              <Item
                key={c.id}
                size="sm"
                title={`${c.runner} — ${truncate(c.workdir, 40)}`}
                onSelect={() => nav({ tab: "work" })}
                actions={
                  <>
                    <Badge color={c.status === "running" ? "lime" : c.status === "waiting_input" ? "yellow" : "zinc"}>
                      {c.status}
                    </Badge>
                    <Text as="span" size="sm" tone="muted">{relTime(c.lastActivityAt)}</Text>
                  </>
                }
              />
            ))}
          </ItemGroup>
        </Section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Senses">
          {senses.length > 0
            ? <div className="flex flex-wrap gap-1.5">{senses.map((s) => <Badge key={s} color="lime">{s}</Badge>)}</div>
            : <Empty variant="plain" align="start" title="No active senses" />}
        </Section>
        <Section title="Bridges">
          {bridges.length > 0
            ? <div className="flex flex-wrap gap-1.5">
                {bridges.map((b) => (
                  <OuroBadge key={b} tone="success" onClick={() => nav({ tab: "connections", focus: b })}>{b}</OuroBadge>
                ))}
              </div>
            : <Empty variant="plain" align="start" title="No active bridges" />}
        </Section>
      </div>

      {fulfilled.length > 0 && (
        <Section title="Recently closed">
          <ItemGroup aria-label="Recently closed">
            {fulfilled.slice(0, 3).map((o, i) => (
              <Item
                key={i}
                size="sm"
                title={<span className="block truncate">{truncate(o.content, 80)}</span>}
                actions={
                  <>
                    <Badge color="lime">closed</Badge>
                    <Text as="span" size="sm" tone="muted">{relTime(o.updatedAt)}</Text>
                  </>
                }
              />
            ))}
          </ItemGroup>
        </Section>
      )}

      <Section title="Recent activity">
        <ItemGroup aria-label="Recent activity" empty={<Empty variant="plain" align="start" title="No recent activity yet." />}>
          {activity.recent.map((item, i) => {
            const tab: TabId = item.kind === "coding" || item.kind === "obligation" ? "work"
              : item.kind === "session" ? "sessions" : "inner"
            return (
              <Item
                key={i}
                title={truncate(item.label, 100)}
                description={<span className="block truncate">{truncate(item.detail, 80)}</span>}
                onSelect={() => nav({ tab })}
                actions={
                  <>
                    <Badge>{item.kind}</Badge>
                    <Text as="span" size="sm" tone="muted">{relTime(item.at)}</Text>
                  </>
                }
              />
            )
          })}
        </ItemGroup>
      </Section>
    </div>
  )
}

function ThreadLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <Button variant="plain" tone="primary" size="inline" onClick={onClick}>{children}</Button>
}

function Meter({ label, value, sub, onClick }: { label: string; value: string | number; sub: string; onClick: () => void }) {
  return (
    <Item
      variant="outline"
      size="sm"
      title={label}
      description={<>
        <Text as="span" size="lg" className="block tabular-nums text-foreground">{value}</Text>
        <span className="block truncate">{sub}</span>
      </>}
      onSelect={onClick}
    />
  )
}

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <SectionHeader title={title} meta={meta} />
      {children}
    </section>
  )
}
