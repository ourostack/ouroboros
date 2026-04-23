# Agent Mail Recovery

This is the harness-facing recovery guide for Agent Mail. Use it when Slugger or another agent needs to diagnose native mail, delegated human-mail sources, outbound delivery state, or autonomy policy from the local runtime side.

The hosted-service operations runbook lives in `ouro-work-substrate` at `docs/mail-recovery-runbook.md`. This document is the agent-side companion: what the agent can run itself, what needs the human, and what evidence is safe to record.

## Current Production Proof

Current production proof state as of April 23, 2026:

- `ouro.bot` MX points to `mx1.ouro.bot`.
- `mx1.ouro.bot:25` reaches the hosted Mail Ingress edge.
- Mail Ingress advertises STARTTLS from mounted PEM secrets.
- Hosted Mail Control can ensure `slugger@ouro.bot` and `me.mendelow.ari.slugger@ouro.bot`.
- Hosted mail storage is Azure Blob Storage with encrypted message and raw MIME payloads.
- The harness stores private mail keys and hosted Blob reader coordinates in the owning agent vault `runtime/config` item.
- Live HEY browser export, HEY forwarding confirmation, ACS domain/provider smoke, and final autonomous-send enablement remain human-gated proof work.

## Recovery Map

| Failure mode | Agent-runnable | Human-required | Body-safe evidence |
| --- | --- | --- | --- |
| DNS/MX drift | Check hosted operations docs, inspect the latest DNS workflow artifacts, and ask the substrate repo workflow to run backup/plan/verify before any apply. | Registrar/API credential access must be in the agent vault; intentional cutover or outbound provider-auth record changes need human confirmation. | DNS answers, provider record ids, plan diff, no secret headers. |
| HEY forwarding missing or stale | Check `mail_recent`, `mail_screener`, source-state records, and Ouro Outlook source folders for the delegated alias. Treat wrong-target probes to `slugger@ouro.bot` as recoverable setup friction. | HEY browser login, MFA, CAPTCHA, forwarding/extension changes, and final forwarding confirmation. | Target alias, observed recipient, message id, forwarding status. |
| hosted registry/vault key drift | Run `ouro account ensure --agent <agent> --owner-email <email> --source hey` or `ouro connect mail --agent <agent> --owner-email <email> --source hey`; the command calls hosted Mail Control when `workSubstrate.mode` is `hosted`. If the ensure response names key ids absent from the vault, rerun with `ouro account ensure --rotate-missing-mail-keys` or `ouro connect mail --rotate-missing-mail-keys` so the harness rotates only the missing hosted keys and stores the fresh one-time private keys. | rotation cannot recover mail already encrypted to a lost private key; it only makes future mail decryptable. Human/provider help may still be needed if old messages matter. | Mailbox/source key ids, ensure/rotation counts, hosted Blob coordinates, no private keys. |
| Blob reader or decryption failure | Run `ouro status`, `ouro doctor`, then rerun `ouro connect mail` after vault unlock if Mailroom config is missing. Check `AUTH_REQUIRED:mailroom` messages and missing-key warnings. `mail_recent`, `mail_search`, and `mail_thread` should keep working around undecryptable records and name only body-safe message/key ids. | Human may need to unlock or repair the owning agent vault. Mail already encrypted to a lost key needs that exact old key restored; rotation only repairs future mail. | Runtime item path, key id, Blob account/container, sanitized error or warning. |
| delivery event missing | Inspect Sent in Ouro Outlook, `mail_access_log`, outbound provider ids, and hosted Event Grid/Event Grid subscription status from the substrate runbook. `submitted` is not final delivery. | Provider console or ACS domain verification may need human/provider access. | Provider message id, Event Grid event id, canonical outcome, safe provider status. |
| autonomy kill switch | Inspect `mailroom.autonomousSendPolicy`; if disabled or `killSwitch` is true, autonomous sends must fall back to `CONFIRM_SEND`. Test with a low-risk draft before changing policy. | Human explicitly approves autonomous-send enablement, allowed recipients/domains, recipient/rate limits, and kill switch changes. | Policy id, decision code, fallback, recipient list/count. |
| wrong mailbox provenance | Compare recipient, `mailboxRole`, `compartmentKind`, `ownerEmail`, and `source` in `mail_recent`, `mail_thread`, `mail_access_log`, and Outlook. Stop if Ari's mail appears as Slugger's native correspondence. | Human confirms ambiguous owner/source grants. | Message id, recipient, mailbox role, source label, owner email. |
| discarded/quarantined recovery | Use Outlook recovery drawers, `mail_screener`, `mail_decide restore`, and `mail_access_log` to explain or restore retained mail. | Family-authorized human decides sender/source policy changes. | Previous/next placement, actor, reason, retained drawer counts. |

## Operator Posture

Agent-runnable:

- `ouro account ensure`
- `ouro connect mail`
- `ouro mail import-mbox`
- `ouro status`
- `ouro doctor`
- `mail_recent`
- `mail_screener`
- `mail_access_log`
- Ouro Outlook inspection

Human-required:

- HEY login, MFA, CAPTCHA, export download, forwarding confirmation, and browser-account ambiguity.
- Registrar/DNS cutover and outbound provider-domain changes.
- Vault unlock or vault replacement when the agent cannot access the owning vault.
- Final approval for autonomous native-agent sending.

Do not parse vault item notes. Notes are for human/agent orientation. If a recovery workflow needs machine-readable facts such as a credential item path, driver, resource allowlist, endpoint, or secret field name, those facts belong in explicit config or a workflow binding.

When a mailbox contains messages encrypted to a missing old private key, do not let that single record collapse the whole mailbox read. Treat the warning as recovery evidence, continue with decryptable messages, and only ask for human help if the old message itself matters enough to hunt for the old key.

## Evidence Rules

Safe evidence:

- Message ids, provider event ids, provider message/operation ids, DNS record ids, key ids, aliases, owner/source labels, status codes, safe summaries, and timestamps.

Unsafe evidence:

- Provider keys, TLS private keys, raw MIME, message bodies, private mail keys, vault unlock material, bearer tokens, and full credential payloads.

When in doubt, write down the path to the evidence and the body-safe summary, not the secret or message content itself.
