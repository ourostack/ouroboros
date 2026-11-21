// The ouro CLI's commands for DNS records and certificates for a binding, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"

export const DNS_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "dns backup", effect: "private", summary: "Back up the DNS records of a binding." },
  { name: "dns plan", effect: "private", readOnly: true, summary: "Show the DNS changes a binding would make." },
  { name: "dns apply", effect: "others", summary: "Apply DNS changes that other people on the internet can reach." },
  { name: "dns verify", effect: "private", readOnly: true, summary: "Check that the DNS records are live." },
  { name: "dns rollback", effect: "private", summary: "Restore the DNS records from a backup." },
  { name: "dns certificate", effect: "private", summary: "Issue or check a certificate for a binding." },
]
