// The ouro CLI's commands for an agent's mail, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { daemonDown, unknownFlag } from "./cards"

export const MAIL_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "mail backfill-indexes", effect: "private", summary: "Rebuild the mail indexes for an agent." },
  { name: "mail sweep-orphans", effect: "private", summary: "Delete unreferenced encrypted raw mail (dry run unless --live)." },
  { name: "mail import-mbox", effect: "private", summary: "Import an MBOX export into the agent's mail." },
  { name: "mailbox", effect: "private", readOnly: true, summary: "Show the agent's mailbox.", ax: { id: "cli:mailbox", group: "mail", effect: "read", when: "Get the local web address where a person can read the agent's mail in a browser.", errors: [unknownFlag("mailbox"), daemonDown("mailbox")], aliases: ["outlook"] } },
]
