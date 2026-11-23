import { Badge } from "../../status-badge"
import { Button } from "@/components/ouro/button/button"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import { relTime, truncate } from "../../../api"
import type { NavigateFn } from "../../../navigation"
import type {
  MailboxCodingDeepItem,
  MailboxObligationDetailItem,
  MailboxObligationItem,
} from "../../../contracts"

type Obligation = MailboxObligationDetailItem | MailboxObligationItem

/** Obligations, each traced to the session it came from, the surface it is on and the coding lanes working on it. */
export function ObligationsSection({ obligations, openCount, primarySelectionReason, codingByObligation, nav }: {
  obligations: Obligation[]
  openCount: number
  primarySelectionReason: string | null | undefined
  codingByObligation: Map<string, MailboxCodingDeepItem[]>
  nav: NavigateFn
}) {
  return (
    <section className="space-y-3">
      <SectionHeader title="Obligations" meta={`${openCount} open`} />
      {primarySelectionReason && <Text size="sm" tone="muted">Primary: {primarySelectionReason}</Text>}
      <ItemGroup aria-label="Obligations" empty={<Empty variant="plain" align="start" title="No open obligations." />}>
        {obligations.map((o) => (
          <ObligationRow key={o.id} obligation={o} linkedCoding={codingByObligation.get(o.id) ?? []} nav={nav} />
        ))}
      </ItemGroup>
    </section>
  )
}

function ObligationRow({ obligation: o, linkedCoding, nav }: { obligation: Obligation; linkedCoding: MailboxCodingDeepItem[]; nav: NavigateFn }) {
  const detail = isDetailedObligation(o) ? o : null
  const isPrimary = detail?.isPrimary ?? false
  const meaning = detail?.meaning ?? null
  const origin = o.origin
  return (
    <Item
      title={truncate(o.content, 120)}
      actions={
        <>
          {isPrimary && <Badge color="lime">primary</Badge>}
          <Badge color={o.status === "pending" ? "yellow" : o.status === "fulfilled" ? "lime" : "zinc"}>{o.status}</Badge>
        </>
      }
      description={
        <div className="mt-1 space-y-1.5">
          {/* Chain: origin session */}
          {origin && (
            <Button
              variant="soft"
              tone="secondary"
              size="sm"
              onClick={() => nav({ tab: "sessions", focus: `${origin.friendId}/${origin.channel}/${origin.key}` })}
            >
              from {origin.channel} &rarr; {origin.key} · open session &rarr;
            </Button>
          )}

          {/* Chain: current surface */}
          {o.currentSurface && (
            <p>surface: {o.currentSurface.kind} — {o.currentSurface.label}</p>
          )}

          {meaning?.waitingOn && <p>Waiting on: {meaning.waitingOn}</p>}

          {/* Chain: linked coding lanes */}
          {linkedCoding.length > 0 && (
            <ItemGroup label="Linked coding" variant="plain">
              {linkedCoding.map((c) => (
                <Item
                  key={c.id}
                  size="sm"
                  title={`${c.runner} — ${c.workdir}`}
                  actions={<Badge color={c.status === "failed" ? "red" : c.status === "running" ? "lime" : "zinc"}>{c.status}</Badge>}
                />
              ))}
            </ItemGroup>
          )}

          {o.nextAction && <p>Next: {o.nextAction}</p>}
          <p>{relTime(o.updatedAt)}</p>
        </div>
      }
    />
  )
}

function isDetailedObligation(obligation: Obligation): obligation is MailboxObligationDetailItem {
  return "isPrimary" in obligation
}
