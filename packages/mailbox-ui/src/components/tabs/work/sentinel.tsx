import { Badge } from "../../status-badge"
import { Alert } from "@/components/ouro/alert/alert"
import { Card } from "@/components/ouro/card/card"
import { DescriptionList } from "@/components/ouro/description-list/description-list"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Separator } from "@/components/ouro/separator/separator"
import { Text } from "@/components/ouro/text/text"
import { relTime, truncate } from "../../../api"
import type { MailboxSentinelReceipt, MailboxSentinelView } from "../../../contracts"

type MailboxSentinelSignal = MailboxSentinelReceipt["signals"][number]

/** The recovery sentinel: its latest receipt, the latest ready one, older receipts, and why it is degraded. */
export function SentinelSection({ view, error }: { view: MailboxSentinelView | null; error: string | null }) {
  return (
    <section className="space-y-3">
      <SectionHeader title="Recovery Sentinel" />
      <SentinelPanel view={view} error={error} />
    </section>
  )
}

function SentinelPanel({ view, error }: { view: MailboxSentinelView | null; error: string | null }) {
  if (error && !view) return <Alert tone="destructive" title="Sentinel unavailable" description={error} />
  if (!view) return null

  const latest = view.latest ?? null
  const latestReady = view.latestReady ?? null
  const promotedReceiptKeys = new Set(
    [latest, latestReady]
      .filter((receipt): receipt is MailboxSentinelReceipt => Boolean(receipt))
      .map(sentinelReceiptKey),
  )
  const history = (view.history ?? []).filter((receipt) => !promotedReceiptKeys.has(sentinelReceiptKey(receipt)))

  return (
    <Card size="sm">
      <div className="space-y-4">
        {error && <Alert tone="destructive" title="Sentinel unavailable" description={error} />}

        {latest ? (
          <SentinelReceiptBlock label="Latest" receipt={latest} prominent />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge>missing</Badge>
            <Text as="span" size="sm" tone="muted">Latest</Text>
          </div>
        )}

        {latestReady && (
          <>
            <Separator />
            <SentinelReceiptBlock label="Latest ready" receipt={latestReady} />
          </>
        )}

        {history.length > 0 && (
          <>
            <Separator />
            <ItemGroup label="History">
              {history.map((receipt) => (
                <SentinelHistoryRow key={sentinelReceiptKey(receipt)} receipt={receipt} />
              ))}
            </ItemGroup>
          </>
        )}

        {view.degraded.issues.length > 0 && (
          <Alert
            tone="warning"
            title="Sentinel degraded"
            description={
              <ul className="space-y-0.5">
                {view.degraded.issues.map((issue) => <li key={issue} className="break-words">{issue}</li>)}
              </ul>
            }
          />
        )}
      </div>
    </Card>
  )
}

function SentinelReceiptBlock({ label, receipt, prominent = false }: { label: string; receipt: MailboxSentinelReceipt; prominent?: boolean }) {
  const sources = uniqueStrings(receipt.sourceLocators)
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text as="span" size="sm" tone="muted">{label}</Text>
        <Badge color={sentinelVerdictColor(receipt.verdict)}>{receipt.verdict}</Badge>
        <span className="font-mono text-xs">{triggerLabel(receipt.trigger)}</span>
        <Text as="span" size="sm" tone="muted">updated {relTime(receipt.generatedAt)}</Text>
      </div>
      <Text size={prominent ? "md" : "sm"} tone={prominent ? "default" : "muted"} className="break-words">
        {receipt.summary}
      </Text>

      <DescriptionList
        items={[
          { term: "Current ask", details: anchorValue(receipt.recoveryAnchor.currentAsk) },
          { term: "Next safe action", details: anchorValue(receipt.recoveryAnchor.nextSafeAction) },
        ]}
      />

      {receipt.signals.length > 0 && (
        <ItemGroup aria-label={`${label} signals`}>
          {receipt.signals.map((signal) => (
            <SentinelSignalRow key={signal.id} signal={signal} />
          ))}
        </ItemGroup>
      )}

      {sources.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Text as="span" size="sm" tone="muted">Sources</Text>
          {sources.map((locator) => (
            <span key={locator} className="max-w-full truncate font-mono text-xs text-muted-foreground">{locator}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function anchorValue(value: string | null): string {
  return value ? truncate(value, 140) : "unknown"
}

function SentinelSignalRow({ signal }: { signal: MailboxSentinelSignal }) {
  return (
    <Item
      size="sm"
      title={signal.summary}
      actions={
        <>
          <span className="font-mono text-xs text-muted-foreground">{signal.kind.replace(/_/g, " ")}</span>
          <Badge color={sentinelSignalColor(signal)}>{signal.status}</Badge>
        </>
      }
      description={
        <>
          <p className="truncate font-mono text-xs">{signal.source.locator}</p>
          {signal.repair && (
            <p className="break-words">
              {signal.repair.actor}: {signal.repair.command ?? signal.repair.detail}
            </p>
          )}
        </>
      }
    />
  )
}

function SentinelHistoryRow({ receipt }: { receipt: MailboxSentinelReceipt }) {
  const firstSignal = receipt.signals[0]?.summary ?? null
  return (
    <Item
      size="sm"
      title={receipt.summary}
      actions={<Badge color={sentinelVerdictColor(receipt.verdict)}>{receipt.verdict}</Badge>}
      description={
        <>
          <p>
            <span className="font-mono">{triggerLabel(receipt.trigger)}</span> · {relTime(receipt.generatedAt)}
          </p>
          {firstSignal && <p className="break-words">{firstSignal}</p>}
          <p className="truncate font-mono text-xs">{receipt.receiptLocator}</p>
        </>
      }
    />
  )
}

function sentinelVerdictColor(verdict: MailboxSentinelReceipt["verdict"]) {
  return verdict === "ready" ? "lime" : verdict === "watch" ? "yellow" : "red"
}

function sentinelSignalColor(signal: MailboxSentinelSignal) {
  if (signal.status === "fail" || signal.severity === "critical") return "red"
  if (signal.status === "warn" || signal.severity === "warn") return "yellow"
  return "lime"
}

function sentinelReceiptKey(receipt: MailboxSentinelReceipt) {
  return receipt.receiptLocator || receipt.id
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function triggerLabel(trigger: MailboxSentinelReceipt["trigger"]) {
  return trigger.replace(/_/g, " ")
}
