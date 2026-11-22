import { useEffect, useRef, useState } from "react"
import { Badge } from "../status-badge"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import { fetchJson, relTime, truncate } from "../../api"
import type {
  MailboxDeskPrefs,
  MailboxSessionInventory as SessionInventory,
  MailboxSessionInventoryItem as SessionItem,
  MailboxSessionTranscript as Transcript,
} from "../../contracts"
import { Loading } from "./sessions/loading"
import { TranscriptPanel, channelLabel } from "./sessions/transcript"

const REPLY_STATE_BADGE: Record<string, { color: "red" | "yellow" | "lime" | "zinc"; label: string }> = {
  "needs-reply": { color: "red", label: "needs reply" },
  "on-hold": { color: "yellow", label: "on hold" },
  "monitoring": { color: "zinc", label: "monitoring" },
  "idle": { color: "zinc", label: "idle" },
}

/** A run of sessions drawn as one list: one person's channels under their name, or people with one session each. */
interface SessionBlock {
  key: string
  person: { name: string; channels: number; starred: boolean } | null
  sessions: SessionItem[]
}

export function SessionsTab({ agentName, focus, onFocusConsumed, deskPrefs, refreshGeneration }: { agentName: string; focus?: string; onFocusConsumed?: () => void; deskPrefs?: MailboxDeskPrefs | null; refreshGeneration: number }) {
  const [inventory, setInventory] = useState<SessionInventory | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loading, setLoading] = useState(false)
  const transcriptRequestRef = useRef<string | null>(null)

  useEffect(() => {
    fetchJson<SessionInventory>(`/agents/${encodeURIComponent(agentName)}/sessions`).then(setInventory)
  }, [agentName, refreshGeneration])

  useEffect(() => {
    if (!focus) return
    transcriptRequestRef.current = null
    setExpandedKey(focus)
    setTranscript(null)
    setLoading(true)
    onFocusConsumed?.()
  }, [agentName, focus, onFocusConsumed])

  useEffect(() => {
    if (!expandedKey) return
    const requestKey = `${expandedKey}:${refreshGeneration}`
    if (transcriptRequestRef.current === requestKey) return
    transcriptRequestRef.current = requestKey
    setLoading(true)
    const [fId, ch, k] = expandedKey.split("/")
    fetchJson<Transcript>(
      `/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(fId!)}/${encodeURIComponent(ch!)}/${encodeURIComponent(k!)}`
    )
      .then(setTranscript)
      .catch(() => setTranscript(null))
      .finally(() => setLoading(false))
  }, [agentName, expandedKey, refreshGeneration, focus])

  function loadTranscript(sessionKey: string) {
    if (expandedKey === sessionKey) {
      setExpandedKey(null)
      setTranscript(null)
      transcriptRequestRef.current = null
      return
    }
    setExpandedKey(sessionKey)
    setTranscript(null)
    setLoading(true)
  }

  const starredFriends = new Set(deskPrefs?.starredFriends ?? [])

  if (!inventory) {
    return <Loading label="Loading sessions" />
  }

  // Group by person, sort starred to top, then by session count
  const byPerson = new Map<string, SessionItem[]>()
  for (const s of inventory.items) {
    if (!byPerson.has(s.friendId)) byPerson.set(s.friendId, [])
    byPerson.get(s.friendId)!.push(s)
  }
  const personEntries = [...byPerson.entries()].sort((a, b) => {
    const aStarred = starredFriends.has(a[0]) ? 0 : 1
    const bStarred = starredFriends.has(b[0]) ? 0 : 1
    if (aStarred !== bStarred) return aStarred - bStarred
    return b[1].length - a[1].length
  })

  // A person with several channels gets a list under their name; people with one session share a list.
  const blocks: SessionBlock[] = []
  for (const [friendId, sessions] of personEntries) {
    if (sessions.length > 1) {
      blocks.push({
        key: friendId,
        person: { name: sessions[0]!.friendName, channels: sessions.length, starred: starredFriends.has(friendId) },
        sessions,
      })
      continue
    }
    const last = blocks[blocks.length - 1]
    if (last && !last.person) last.sessions.push(...sessions)
    else blocks.push({ key: friendId, person: null, sessions: [...sessions] })
  }

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Sessions"
        meta={`${inventory.totalCount} sessions · ${inventory.activeCount} active · ${inventory.staleCount} stale`}
      />

      <div className="space-y-3">
        {blocks.map((block) => (
          <div key={block.key} className="space-y-1">
            {/* Person header — shows when same person has multiple channels */}
            {block.person && (
              <div className="flex items-center gap-2 pt-3">
                {block.person.starred && <span className="text-sm text-ouro-gold">★</span>}
                <span className="text-sm font-medium">{block.person.name}</span>
                <Text as="span" size="sm" tone="muted">{block.person.channels} channels</Text>
              </div>
            )}
            <ItemGroup aria-label={block.person ? `${block.person.name}'s sessions` : "Sessions"}>
              {block.sessions.map((s) => {
                const key = `${s.friendId}/${s.channel}/${s.key}`
                const isOpen = expandedKey === key
                return (
                  <div key={key}>
                    <SessionRow
                      session={s}
                      starred={starredFriends.has(s.friendId)}
                      selected={isOpen}
                      onSelect={() => loadTranscript(key)}
                    />
                    {isOpen && <TranscriptPanel loading={loading} transcript={transcript} />}
                  </div>
                )
              })}
            </ItemGroup>
          </div>
        ))}
      </div>
    </div>
  )
}

function SessionRow({ session: s, starred, selected, onSelect }: { session: SessionItem; starred: boolean; selected: boolean; onSelect: () => void }) {
  const badge = REPLY_STATE_BADGE[s.replyState] ?? REPLY_STATE_BADGE.idle!
  // Context pressure: last-turn input_tokens is the real count from the API
  // Agent maxTokens defaults to 80k, context oscillates between 64k (trimmed) and 80k (before trim)
  const inputTokens = s.lastUsage?.total_tokens ?? s.estimatedTokens ?? 0
  const maxTokens = 80000
  const pressurePct = inputTokens > 0 ? Math.min(100, Math.round((inputTokens / maxTokens) * 100)) : 0

  return (
    <Item
      selected={selected}
      onSelect={onSelect}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {starred && <span className="text-ouro-gold" title="Starred">★</span>}
          <span className="truncate">{s.friendName}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">via {channelLabel(s.channel)}</span>
          <Badge color={badge.color}>{badge.label}</Badge>
        </span>
      }
      actions={<span className="text-xs tabular-nums text-muted-foreground">{relTime(s.lastActivityAt)}</span>}
      description={
        <div className="mt-1 space-y-1">
          {/* Last inbound + last outbound — session state at a glance */}
          {s.latestUserExcerpt && (
            <p className="truncate text-xs">
              <span className="font-mono text-[9px] uppercase tracking-wider">in:</span> {truncate(s.latestUserExcerpt, 100)}
            </p>
          )}
          {s.latestAssistantExcerpt && (
            <p className="truncate text-xs">
              <span className="font-mono text-[9px] uppercase tracking-wider">out:</span> {truncate(s.latestAssistantExcerpt, 100)}
            </p>
          )}

          {/* Stats + context pressure bar */}
          <div className="flex items-center gap-3 text-xs">
            <span className="tabular-nums">{s.messageCount} msgs</span>
            {s.lastUsage && <span className="tabular-nums">{s.lastUsage.total_tokens.toLocaleString()} tok</span>}
            {pressurePct > 0 && (
              <div className="flex max-w-32 flex-1 items-center gap-1.5" title="Context pressure — steady state oscillates between 80-100%">
                <div className="h-1 flex-1 rounded-full bg-muted">
                  <div
                    className={`h-1 rounded-full transition-all ${
                      pressurePct > 100 ? "bg-destructive" : pressurePct > 80 ? "bg-warning" : "bg-success"
                    }`}
                    style={{ width: `${Math.min(100, pressurePct)}%` }}
                  />
                </div>
                <span className="text-[10px] tabular-nums">{pressurePct}%</span>
              </div>
            )}
          </div>
        </div>
      }
    />
  )
}
