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
- `ouro mail import-mbox` can backfill delegated mail into a hosted Mailroom by streaming large local MBOX files, recomputing `sourceFreshThrough`, and deduping safely on rerun after interruption.
- Live HEY browser export, HEY forwarding confirmation, ACS domain/provider smoke, and final autonomous-send enablement remain human-gated proof work.

## Recovery Map

| Failure mode | Agent-runnable | Human-required | Body-safe evidence |
| --- | --- | --- | --- |
| DNS/MX drift | Check hosted operations docs, inspect the latest DNS workflow artifacts, and ask the substrate repo workflow to run backup/plan/verify before any apply. | Registrar/API credential access must be in the agent vault; intentional cutover or outbound provider-auth record changes need human confirmation. | DNS answers, provider record ids, plan diff, no secret headers. |
| HEY forwarding missing or stale | Check `mail_recent`, `mail_screener`, source-state records, and Ouro Mailbox source folders for the delegated alias. Treat wrong-target probes to `slugger@ouro.bot` as recoverable setup friction. | HEY browser login, MFA, CAPTCHA, forwarding/extension changes, and final forwarding confirmation. | Target alias, observed recipient, message id, forwarding status. |
| HEY linked account only partially onboarded | Check which HEY account/address produced the last export and the last forwarding proof. Treat one HEY login showing multiple linked accounts as shared auth, not shared onboarding state. | Password re-entry, export start, or forwarding confirmation may still be required for the specific HEY account that has not been proven yet. | HEY account address, delegated alias, `sourceFreshThrough`, forwarding status, proof message id. |
| import state is unclear | Start with `mail_status` for the lane map, recent browser/download archives, recent import operations, and explicit archive freshness truth. Treat `freshness: current` as "newest known archive for this delegated lane; re-import unnecessary," `freshness: current older snapshot` as "already imported history for this delegated lane, but not the newest known archive," and `freshness: stale-risky` as "a newer archive appeared after the last successful import; re-import needed before claiming freshness." If the local filename suggests a different account label than the delegated binding, trust the owner/source mapping note over the filename hint. Then use `query_active_work` for the live operation id, timestamps, `failure class`, `retry`, and `recovery` lines. Treat `ready (newer than last import via <op>)` as "a new export appeared at the same path" rather than as contradictory success state. | None unless the newer archive came from a human-gated HEY export that has not been downloaded yet. | Operation id, archive path, origin label, failure class, retry disposition, import counts. |
| already-imported archive keeps reappearing as ready | Check recent background operations and the archive file's mtime. A successfully imported archive should stop surfacing as ambient import-ready work unless the file on disk is newer than the last successful import record. | None for the steady-state case. Human action is only needed when HEY has produced a genuinely newer export that should be imported. | Operation id, archive path, recorded `fileModifiedAt`, latest success timestamp. |
| malformed file-backed access log | Keep the good audit rows visible, skip malformed/truncated JSONL tail lines, and surface a warning that names how many lines were skipped. Treat the warning as evidence of a local file-write issue, not as permission to hide the rest of the audit trail. | None unless the underlying disk/file-write problem needs broader machine repair. | Warning count, surviving access-log rows, file path, latest valid audit timestamp. |
| daemon stopped or worker state stale | Start with `ouro status` and `ouro doctor`, not cached `runtime.json` alone. If the daemon is down or the worker pid is missing, run `ouro up`, then re-check Mail sense health, worker liveness, and recent runtime log events. If you have just rebuilt or swapped the installed CLI `dist` and `ouro up` reports the background service was already running, that is not a code reload; force a real worker restart with `ouro down` followed by `ouro up`, then confirm the worker pid changed before trusting live behavior. | None unless the restart reveals a real provider/browser auth problem that truly needs human action. | Daemon tombstone reason/time, live worker pid, latest runtime log event, `ouro status` output. |
| hosted registry/vault key drift | Run `ouro account ensure --agent <agent> --owner-email <email> --source hey` or `ouro connect mail --agent <agent> --owner-email <email> --source hey`; the command calls hosted Mail Control when `workSubstrate.mode` is `hosted`. If the ensure response names key ids absent from the vault, rerun with `ouro account ensure --rotate-missing-mail-keys` or `ouro connect mail --rotate-missing-mail-keys` so the harness rotates only the missing hosted keys and stores the fresh one-time private keys. | rotation cannot recover mail already encrypted to a lost private key; it only makes future mail decryptable. Human/provider help may still be needed if old messages matter. | Mailbox/source key ids, ensure/rotation counts, hosted Blob coordinates, no private keys. |
| Blob reader or decryption failure | Run `ouro status`, `ouro doctor`, then rerun `ouro connect mail` after vault unlock if Mailroom config is missing. Check `AUTH_REQUIRED:mailroom` messages and missing-key warnings. `mail_recent`, `mail_search`, and `mail_thread` should keep working around undecryptable records and name only body-safe message/key ids. | Human may need to unlock or repair the owning agent vault. Mail already encrypted to a lost key needs that exact old key restored; rotation only repairs future mail. | Runtime item path, key id, Blob account/container, sanitized error or warning. |
| delivery event missing | Inspect Sent in Ouro Mailbox, `mail_access_log`, outbound provider ids, and hosted Event Grid/Event Grid subscription status from the substrate runbook. `submitted` is not final delivery. | Provider console or ACS domain verification may need human/provider access. | Provider message id, Event Grid event id, canonical outcome, safe provider status. |
| autonomy kill switch | Inspect `mailroom.autonomousSendPolicy`; if disabled or `killSwitch` is true, autonomous sends must fall back to `CONFIRM_SEND`. Test with a low-risk draft before changing policy. | Human explicitly approves autonomous-send enablement, allowed recipients/domains, recipient/rate limits, and kill switch changes. | Policy id, decision code, fallback, recipient list/count. |
| wrong mailbox provenance | Compare recipient, `mailboxRole`, `compartmentKind`, `ownerEmail`, and `source` in `mail_recent`, `mail_thread`, `mail_access_log`, and Ouro Mailbox. Stop if Ari's mail appears as Slugger's native correspondence. | Human confirms ambiguous owner/source grants. | Message id, recipient, mailbox role, source label, owner email. |
| discarded/quarantined recovery | Use Mailbox recovery drawers, `mail_screener`, `mail_decide restore`, and `mail_access_log` to explain or restore retained mail. | Family-authorized human decides sender/source policy changes. | Previous/next placement, actor, reason, retained drawer counts. |

`mail_recent` is a recency inspector, not a proof surface for absence. When a delegated lane has thousands of imported messages, older itineraries can disappear from the newest slice while still existing in the archive. `mail_search` should search the full visible corpus inside the requested scope and source filter so historical work mail stays discoverable even after hundreds of newer receipts or newsletters arrive. Natural anchor lists are valid search input: literal phrases, `OR` disjunctions, and simple comma-separated booking-code/vendor lists should all work. Imported-archive fallback must search parsed message text, not only raw archive bytes, so quoted-printable or HTML-heavy booking mail remains discoverable.

Delegated-mail absence proof has a stricter contract than ordinary convenience search. Local search-cache hits are seeds, never corpus coverage: a partial cache must not end a delegated search early, and `No matching mail.` is only meaningful after the live visible mailbox and any available imported archives for the requested scope/source have also been searched or the tool says why they could not be searched. For delegated/source-bound searches, preserve the `search coverage:` line in tool output and treat it as part of the evidence. If the coverage line says only cache was searched, or cannot account for the delegated lane, do not call a travel booking, receipt, or other work fact a gap; repair search/import visibility first.

## Operator Posture

Agent-runnable:

- `ouro account ensure`
- `ouro connect mail`
- `ouro mail import-mbox`
- `ouro status`
- `ouro doctor`
- `mail_status`
- `mail_recent`
- `mail_screener`
- `mail_access_log`
- Ouro Mailbox inspection

Human-required:

- HEY login, MFA, CAPTCHA, export download, forwarding confirmation, and browser-account ambiguity.
- Registrar/DNS cutover and outbound provider-domain changes.
- Vault unlock or vault replacement when the agent cannot access the owning vault.
- Final approval for autonomous native-agent sending.

Do not parse vault item notes. Notes are for human/agent orientation. If a recovery workflow needs machine-readable facts such as a credential item path, driver, resource allowlist, endpoint, or secret field name, those facts belong in explicit config or a workflow binding.

Treat cached `runtime.json` files as hints, not truth. Live daemon/worker state comes from `ouro status`, `ouro doctor`, and the current process/runtime logs.

When a mailbox contains messages encrypted to a missing old private key, do not let that single record collapse the whole mailbox read. Treat the warning as recovery evidence, continue with decryptable messages, and only ask for human help if the old message itself matters enough to hunt for the old key.

Graceful degradation contracts to preserve:

- `mail_access_log` keeps readable audit rows visible and says `warning: skipped N malformed file-backed mail access log line(s)` when the local JSONL tail is malformed.
- `mail_recent` and `mail_search` keep decryptable mail visible and say `N mail message(s) could not be decrypted` when older records were encrypted to a missing key.
- `No matching mail.` plus that decrypt warning means "no readable match," not "mail never existed."
- `mail_thread` should say the message `could not be decrypted` instead of silently pretending the message is absent.

## Evidence Rules

Safe evidence:

- Message ids, provider event ids, provider message/operation ids, DNS record ids, key ids, aliases, owner/source labels, status codes, safe summaries, and timestamps.

Unsafe evidence:

- Provider keys, TLS private keys, raw MIME, message bodies, private mail keys, vault unlock material, bearer tokens, and full credential payloads.

When in doubt, write down the path to the evidence and the body-safe summary, not the secret or message content itself.
