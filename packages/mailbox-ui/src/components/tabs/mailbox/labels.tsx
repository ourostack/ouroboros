import { Badge } from "@/components/ouro/badge/badge"
import type {
  MailboxMailMessageSummary,
  MailboxMailOutboundRecord,
  MailboxMailView,
} from "../../../contracts"

export function addressLine(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(unknown)"
}

export function subjectLine(message: MailboxMailMessageSummary): string {
  return message.subject || "(no subject)"
}

export function provenanceLabel(message: MailboxMailMessageSummary): string {
  if (message.provenance.compartmentKind === "delegated") {
    return `delegated human mailbox · ${message.provenance.ownerEmail ?? "unknown owner"} / ${message.provenance.source ?? "unknown source"}`
  }
  return "native agent mailbox"
}

export function accessProvenanceLabel(entry: MailboxMailView["accessLog"][number]): string {
  if (entry.mailboxRole === "delegated-human-mailbox") {
    return `delegated human mailbox · ${entry.ownerEmail ?? "unknown owner"} / ${entry.source ?? "unknown source"}`
  }
  if (entry.mailboxRole === "agent-native-mailbox") return "native agent mailbox"
  return "mailbox"
}

export function sendAuthorityLabel(record: MailboxMailOutboundRecord): string {
  if (record.sendAuthority === "agent-native") return "native agent mailbox"
  return record.mailboxRole
}

export function outboundTransportLabel(record: MailboxMailOutboundRecord): string {
  return record.transport ?? record.provider ?? "not sent"
}

export function outboundEventTime(record: MailboxMailOutboundRecord): string {
  return record.deliveredAt ?? record.failedAt ?? record.acceptedAt ?? record.sentAt ?? record.submittedAt ?? record.updatedAt
}

const PLACEMENT_TONES: Record<string, "primary" | "secondary" | "destructive" | "success" | "warning"> = {
  screener: "warning",
  discarded: "destructive",
  quarantine: "destructive",
  sent: "success",
  draft: "primary",
}

/** A message's placement, or an outbound record's status, as a soft badge in its tone. */
export function PlacementBadge({ placement }: { placement: string }) {
  return <Badge tone={PLACEMENT_TONES[placement] ?? "secondary"} variant="soft">{placement}</Badge>
}
