import { Alert } from "@/components/ouro/alert/alert"
import { DescriptionList, type DescriptionListItem } from "@/components/ouro/description-list/description-list"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { PageHeader } from "@/components/ouro/page-header/page-header"
import { Separator } from "@/components/ouro/separator/separator"
import { Text } from "@/components/ouro/text/text"
import type { MailboxMailMessageView } from "../../../contracts"
import { addressLine, PlacementBadge, provenanceLabel, subjectLine } from "./labels"

/** One message, read-only: its headers, the untrusted-content warning, its text body, why it was read, and its attachments. */
export function ReadingPane({ detail }: { detail: MailboxMailMessageView }) {
  const message = detail.message!
  const headers: DescriptionListItem[] = [
    { term: "From", details: addressLine(message.from) },
    { term: "To", details: addressLine(message.to) },
    ...(message.cc.length > 0 ? [{ term: "Cc", details: addressLine(message.cc) }] : []),
    { term: "Received", details: new Date(message.receivedAt).toLocaleString() },
    { term: "Provenance", details: provenanceLabel(message) },
  ]
  return (
    <article className="min-h-[66vh] space-y-5 px-6 py-5">
      <PageHeader level={2} title={subjectLine(message)} actions={<PlacementBadge placement={message.placement} />} />
      <DescriptionList items={headers} />
      <Alert tone="primary" title={message.untrustedContentWarning} />
      <div>
        <Text as="div" className="whitespace-pre-wrap break-words">{message.text || "(no text body)"}</Text>
        {message.bodyTruncated && <Text size="sm" tone="muted" className="mt-4">Body truncated in Mailbox.</Text>}
      </div>
      <Separator />
      <DescriptionList
        items={[
          { term: "Read reason", details: message.access.reason },
          { term: "Read at", details: new Date(message.access.accessedAt).toLocaleString() },
        ]}
      />
      {message.attachments.length > 0 && (
        <ItemGroup label="Attachments" variant="outline">
          {message.attachments.map((attachment) => (
            <Item
              key={`${attachment.filename}-${attachment.size}`}
              size="sm"
              title={attachment.filename}
              description={`${attachment.contentType} · ${attachment.size.toLocaleString()} bytes`}
            />
          ))}
        </ItemGroup>
      )}
    </article>
  )
}

/** The reading pane before a message is chosen. */
export function EmptyReadingPane() {
  return (
    <div className="grid min-h-[54vh] place-items-center p-8">
      <Empty variant="plain" title="No message selected" description="Reading pane idle." />
    </div>
  )
}

/** The reading pane when the chosen message could not be opened. */
export function UnavailableReadingPane({ error }: { error: string | null | undefined }) {
  return (
    <div className="grid min-h-[54vh] place-items-center p-8">
      <Empty variant="plain" title="Message unavailable" description={error} />
    </div>
  )
}
