import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import { relTime, truncate } from "../../../api"
import type { MailboxMailMessageSummary, MailboxMailOutboundRecord } from "../../../contracts"
import {
  addressLine,
  outboundEventTime,
  outboundTransportLabel,
  PlacementBadge,
  provenanceLabel,
  sendAuthorityLabel,
  subjectLine,
} from "./labels"

/** The open folder's messages, or its outbound records in Drafts and Sent; pressing a message opens it. */
export function MessageList({ folderLabel, messages, outbound, selectedId, onSelect }: {
  folderLabel: string
  messages: MailboxMailMessageSummary[]
  outbound: MailboxMailOutboundRecord[]
  selectedId: string | null
  onSelect: (messageId: string) => void
}) {
  const showOutbound = outbound.length > 0
  return (
    <div className="space-y-2">
      <SectionHeader
        level={3}
        title={folderLabel}
        meta={showOutbound ? `${outbound.length} outbound records` : `${messages.length} messages`}
      />
      <div className="max-h-[66vh] overflow-y-auto">
        <ItemGroup aria-label={`${folderLabel} messages`} empty={<Empty variant="plain" title="No records here." />}>
          {showOutbound
            ? outbound.map((record) => <OutboundRow key={record.id} record={record} />)
            : messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  selected={selectedId === message.id}
                  onSelect={() => onSelect(message.id)}
                />
              ))}
        </ItemGroup>
      </div>
    </div>
  )
}

function MessageRow({ message, selected, onSelect }: {
  message: MailboxMailMessageSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Item
      selected={selected}
      onSelect={onSelect}
      title={<span className="block truncate">{addressLine(message.from)}</span>}
      actions={<span className="text-xs tabular-nums text-muted-foreground">{relTime(message.receivedAt)}</span>}
      description={
        <div className="space-y-1">
          <Text as="span" size="sm" truncate className="block">{subjectLine(message)}</Text>
          <Text as="span" size="sm" tone="muted" lines={2} className="block">{truncate(message.snippet, 150)}</Text>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <PlacementBadge placement={message.placement} />
            <span className="truncate text-xs">{provenanceLabel(message)}</span>
          </div>
        </div>
      }
    />
  )
}

function OutboundRow({ record }: { record: MailboxMailOutboundRecord }) {
  const latestDeliveryEvent = record.deliveryEvents[record.deliveryEvents.length - 1]
  return (
    <Item
      title={<span className="block truncate">{record.subject || "(no subject)"}</span>}
      actions={<PlacementBadge placement={record.status} />}
      description={
        <div className="space-y-1 text-xs">
          <p className="truncate">to {addressLine(record.to)}</p>
          <p>{outboundTransportLabel(record)} · {relTime(outboundEventTime(record))}</p>
          <p className="truncate">
            {sendAuthorityLabel(record)} · {record.sendMode ?? "mode unknown"}
            {record.policyDecision ? ` · policy ${record.policyDecision.code} / ${record.policyDecision.fallback}` : ""}
          </p>
          {(record.providerMessageId || record.providerRequestId) && (
            <p className="truncate">
              provider {record.providerMessageId ?? "unknown"}{record.providerRequestId ? ` · request ${record.providerRequestId}` : ""}
            </p>
          )}
          {latestDeliveryEvent && <p className="line-clamp-2">{latestDeliveryEvent.bodySafeSummary}</p>}
        </div>
      }
    />
  )
}
