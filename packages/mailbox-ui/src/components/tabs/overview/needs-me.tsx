import type { Dispatch, SetStateAction } from "react"
import { Button } from "@/components/ouro/button/button"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import { Badge } from "../../status-badge"
import { fetchJson } from "../../../api"
import type { NavigateFn, TabId } from "../../../navigation"
import type { MailboxNeedsMeItem, MailboxNeedsMeView } from "../../../contracts"

const URGENCY_COLORS: Record<string, "red" | "yellow" | "lime" | "zinc"> = {
  "owed-reply": "red",
  "blocking-obligation": "red",
  "broken-return": "red",
  "stale-delegation": "yellow",
  "return-ready": "lime",
  "overdue-habit": "yellow",
}

const URGENCY_LABELS: Record<string, string> = {
  "owed-reply": "owed reply",
  "blocking-obligation": "blocking",
  "broken-return": "broken return",
  "stale-delegation": "stale",
  "return-ready": "ready to return",
  "overdue-habit": "overdue",
}

const URGENCY_WHY: Record<string, string> = {
  "owed-reply": "Someone spoke last and is waiting for your response",
  "blocking-obligation": "This obligation is open and blocking forward progress",
  "broken-return": "Work was done but the result was never returned to the requester",
  "stale-delegation": "This was delegated to you and hasn't been addressed",
  "return-ready": "The result is ready — deliver it to close the loop",
  "overdue-habit": "This routine is past its scheduled cadence",
}

const STALE_URGENCIES = new Set(["stale-delegation"])
const ACTION_URGENCIES = new Set(["owed-reply", "blocking-obligation", "broken-return", "return-ready", "overdue-habit"])

function dismissObligation(agentName: string, obligationId: string) {
  return fetch(`/api/agents/${encodeURIComponent(agentName)}/dismiss-obligation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ obligationId }),
  })
}

/** "What needs me now": the triaged queue, split into what needs action now and what has gone stale. */
export function NeedsMeSection({ needsMe, setNeedsMe, agentName, nav }: {
  needsMe: MailboxNeedsMeView
  setNeedsMe: Dispatch<SetStateAction<MailboxNeedsMeView | null>>
  agentName: string
  nav: NavigateFn
}) {
  const actionItems = needsMe.items.filter((i) => ACTION_URGENCIES.has(i.urgency))
  const staleItems = needsMe.items.filter((i) => STALE_URGENCIES.has(i.urgency))
  const reload = () => fetchJson<MailboxNeedsMeView>(`/agents/${encodeURIComponent(agentName)}/needs-me`).then(setNeedsMe)

  return (
    <div className="space-y-4">
      {actionItems.length > 0 && (
        <section className="space-y-2">
          <SectionHeader title="Action now" meta={actionItems.length} />
          <ItemGroup variant="outline" aria-label="Action now">
            {actionItems.map((item, i) => (
              <NeedsMeRow key={`action-${i}`} item={item} nav={nav} agentName={agentName} onDismiss={() => {
                setNeedsMe((prev) => prev ? { items: prev.items.filter((_, idx) => needsMe.items.indexOf(item) !== idx) } : prev)
              }} />
            ))}
          </ItemGroup>
        </section>
      )}

      {staleItems.length > 0 && (
        <section className="space-y-2">
          <SectionHeader
            title="Stale"
            meta={staleItems.length}
            actions={
              <Button
                variant="plain"
                tone="warning"
                size="sm"
                onClick={async () => {
                  for (const item of staleItems) {
                    if (item.ref?.focus) await dismissObligation(agentName, item.ref.focus)
                  }
                  reload()
                }}
              >
                Clear all stale
              </Button>
            }
          />
          <ItemGroup variant="outline" aria-label="Stale">
            {staleItems.map((item, i) => (
              <NeedsMeRow key={`stale-${i}`} item={item} nav={nav} agentName={agentName} onDismiss={() => { reload() }} />
            ))}
          </ItemGroup>
        </section>
      )}
    </div>
  )
}

function formatAge(ageMs: number): string {
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m`
  if (ageMs < 86400000) return `${Math.floor(ageMs / 3600000)}h`
  return `${Math.floor(ageMs / 86400000)}d`
}

function NeedsMeRow({ item, nav, agentName, onDismiss }: { item: MailboxNeedsMeItem; nav: NavigateFn; agentName: string; onDismiss: () => void }) {
  const dismissFocus = item.ref?.focus
  return (
    <Item
      title={item.label}
      onSelect={() => item.ref && nav({ tab: item.ref.tab as TabId, focus: item.ref.focus })}
      description={
        <>
          <Text size="sm" tone="muted" truncate>{item.detail}</Text>
          <Text size="sm" tone="muted">{URGENCY_WHY[item.urgency] ?? ""}</Text>
        </>
      }
      actions={
        <>
          <Badge color={URGENCY_COLORS[item.urgency] ?? "zinc"}>
            {URGENCY_LABELS[item.urgency] ?? item.urgency}
          </Badge>
          {item.ageMs != null && (
            <Text as="span" size="sm" tone="muted" className="tabular-nums">{formatAge(item.ageMs)}</Text>
          )}
          {dismissFocus && (
            <Button
              variant="plain"
              tone="secondary"
              size="sm"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={async (e) => {
                e.stopPropagation()
                await dismissObligation(agentName, dismissFocus)
                onDismiss()
              }}
            >
              ✕
            </Button>
          )}
        </>
      }
    />
  )
}
