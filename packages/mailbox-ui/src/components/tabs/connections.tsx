import { useEffect, useState } from "react"
import { Badge } from "../status-badge"
import { Badge as OuroBadge } from "@/components/ouro/badge/badge"
import { Button } from "@/components/ouro/button/button"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate } from "../../navigation"
import type { MailboxAttentionView, MailboxBridgeInventory, MailboxFriendView } from "../../contracts"

export function ConnectionsTab({ agentName, focus, onFocusConsumed, refreshGeneration }: { agentName: string; focus?: string; onFocusConsumed?: () => void; refreshGeneration: number }) {
  const nav = useNavigate()
  const [attention, setAttention] = useState<MailboxAttentionView | null>(null)
  const [bridges, setBridges] = useState<MailboxBridgeInventory | null>(null)
  const [friends, setFriends] = useState<MailboxFriendView | null>(null)

  useEffect(() => {
    const base = `/agents/${encodeURIComponent(agentName)}`
    Promise.all([
      fetchJson<MailboxAttentionView>(`${base}/attention`).then(setAttention),
      fetchJson<MailboxBridgeInventory>(`${base}/bridges`).then(setBridges),
      fetchJson<MailboxFriendView>(`${base}/friends`).then(setFriends),
    ])
  }, [agentName, refreshGeneration])

  const queueItems = attention?.queueItems ?? []
  const bridgeItems = bridges?.items ?? []
  const friendItems = friends?.friends ?? []

  return (
    <div className="space-y-8">
      {/* Attention queue — who is waiting on me? */}
      <section className="space-y-3">
        <SectionHeader title="Who is waiting" meta={attention?.queueLength ?? 0} />
        <ItemGroup aria-label="Who is waiting" empty={<Empty title="Nobody waiting." variant="plain" align="start" />}>
          {queueItems.map((item, i) => {
            const bridgeId = item.bridgeId
            const obligationId = item.obligationId

            return (
              <Item
                key={i}
                title={item.friendName}
                onSelect={() => nav({ tab: "sessions" })}
                actions={<Badge color="yellow">waiting {relTime(new Date(item.timestamp).toISOString())}</Badge>}
                description={
                  <div className="space-y-1.5">
                    <p>via {item.channel}</p>
                    <Text size="sm" tone="default">{truncate(item.delegatedContent, 140)}</Text>
                    {(bridgeId || obligationId) && (
                      <div className="flex flex-wrap gap-2">
                        {bridgeId && (
                          <Button variant="plain" size="sm" onClick={() => nav({ tab: "connections", focus: bridgeId })}>
                            bridge: {bridgeId.slice(0, 12)}…
                          </Button>
                        )}
                        {obligationId && (
                          <Button variant="plain" size="sm" onClick={() => nav({ tab: "work", focus: obligationId })}>
                            obligation: {obligationId.slice(0, 16)}…
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                }
              />
            )
          })}
        </ItemGroup>
      </section>

      {/* Bridges — "why should I care?" visible in 2 seconds */}
      <section className="space-y-3">
        <SectionHeader title="Bridges" meta={bridges?.totalCount ?? 0} />
        <ItemGroup aria-label="Bridges" empty={<Empty title="No bridges." variant="plain" align="start" />}>
          {bridgeItems.map((b) => {
            const sessions = b.attachedSessions
            const task = b.task
            const isActive = b.lifecycle === "active"

            return (
              <Item
                key={b.id}
                // Line 1: the objective (the "why should I care" sentence), with its lifecycle
                title={b.objective}
                actions={<Badge color={isActive ? "lime" : "zinc"}>{b.lifecycle}</Badge>}
                description={
                  <div className="space-y-2">
                    {/* Line 2: summary — the short explanation */}
                    {b.summary && <Text size="sm" tone="default">{truncate(b.summary, 160)}</Text>}

                    {/* Attached sessions — clickable, shows who's involved */}
                    {sessions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {sessions.map((s, i) => (
                          <OuroBadge
                            key={i}
                            tone="primary"
                            variant="soft"
                            onClick={() => nav({ tab: "sessions", focus: `${s.friendId}/${s.channel}/${s.key}` })}
                          >
                            {s.friendId}/{s.channel}/{s.key}
                          </OuroBadge>
                        ))}
                      </div>
                    )}

                    {/* Linked task */}
                    {task && (
                      <p>
                        <Button variant="plain" size="sm" onClick={() => nav({ tab: "work" })}>
                          task: {task.taskName}
                        </Button>
                        <span> ({task.mode})</span>
                      </p>
                    )}

                    <p>{relTime(b.updatedAt)}</p>
                  </div>
                }
              />
            )
          })}
        </ItemGroup>
      </section>

      {/* Friends */}
      <section className="space-y-3">
        <SectionHeader title="Friends" meta={friends?.totalFriends ?? 0} />
        <ItemGroup aria-label="Friends" empty={<Empty title="No friends." variant="plain" align="start" />}>
          {friendItems.map((f) => (
            <Item
              key={f.friendId}
              title={f.friendName}
              onSelect={() => nav({ tab: "sessions" })}
              description={
                <>
                  {f.channels.join(", ")} · {f.sessionCount} sessions
                  {f.lastActivityAt && <> · {relTime(f.lastActivityAt)}</>}
                </>
              }
              actions={
                <div className="text-right">
                  <Text as="p" size="sm" tone="default" className="tabular-nums">{f.totalTokens.toLocaleString()}</Text>
                  <Text as="p" size="sm" tone="muted">tokens</Text>
                </div>
              }
            />
          ))}
        </ItemGroup>
      </section>
    </div>
  )
}
