import { DescriptionList } from "@/components/ouro/description-list/description-list"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import type { MailboxMailFolder, MailboxMailView } from "../../../contracts"
import { accessProvenanceLabel } from "./labels"

/** The folders, each a row that shows its messages, with its count. */
export function FolderRail({ folders, activeFolder, setActiveFolder }: {
  folders: MailboxMailFolder[]
  activeFolder: string
  setActiveFolder: (folder: string) => void
}) {
  return (
    <ItemGroup aria-label="Folders" variant="plain">
      {folders.map((folder) => (
        <Item
          key={folder.id}
          size="sm"
          title={folder.label}
          selected={activeFolder === folder.id}
          onSelect={() => setActiveFolder(folder.id)}
          actions={<span className="text-xs tabular-nums text-muted-foreground">{folder.count}</span>}
        />
      ))}
    </ItemGroup>
  )
}

/** How many messages sit in each recovery drawer, and which keys are missing for the undecryptable ones. */
export function RecoveryBlock({
  discarded,
  quarantine,
  undecryptable,
  missingKeyIds,
}: {
  discarded: number
  quarantine: number
  undecryptable: number
  missingKeyIds: string[]
}) {
  return (
    <section className="space-y-2">
      <SectionHeader level={3} title="Recovery drawers" />
      <DescriptionList
        items={[
          { term: "Discarded", details: <span className="tabular-nums">{discarded}</span> },
          { term: "Quarantine", details: <span className="tabular-nums">{quarantine}</span> },
          { term: "Undecryptable", details: <span className="tabular-nums">{undecryptable}</span> },
        ]}
      />
      {undecryptable > 0 && (
        <Text size="sm" tone="muted">
          missing key {missingKeyIds[0]}
          {missingKeyIds.length > 1 ? ` +${missingKeyIds.length - 1} more` : ""}
        </Text>
      )}
    </section>
  )
}

/** The first senders waiting in the screener; pressing one opens their message. */
export function ScreenerBlock({ candidates, onOpen }: {
  candidates: MailboxMailView["screener"]
  onOpen: (messageId: string) => void
}) {
  return (
    <section className="space-y-2">
      <SectionHeader level={3} title="Screener" />
      <ItemGroup aria-label="Pending senders" empty="No pending senders.">
        {candidates.slice(0, 5).map((candidate) => (
          <Item
            key={candidate.id}
            size="sm"
            title={<span className="block truncate">{candidate.senderEmail}</span>}
            description={<span className="block truncate">{candidate.trustReason}</span>}
            onSelect={() => onOpen(candidate.messageId)}
          />
        ))}
      </ItemGroup>
    </section>
  )
}

/** The latest reads of the mailbox: the tool, which mailbox, and why. */
export function AccessBlock({ entries }: { entries: MailboxMailView["accessLog"] }) {
  return (
    <section className="space-y-2">
      <SectionHeader level={3} title="Access audit" />
      <ItemGroup aria-label="Recent mailbox reads" empty="No reads yet.">
        {entries.slice(0, 4).map((entry) => (
          <Item
            key={entry.id}
            size="sm"
            title={<span className="block truncate">{entry.tool}</span>}
            description={
              <>
                <span className="block truncate">{accessProvenanceLabel(entry)}</span>
                <span className="block truncate">{entry.reason}</span>
              </>
            }
          />
        ))}
      </ItemGroup>
    </section>
  )
}
