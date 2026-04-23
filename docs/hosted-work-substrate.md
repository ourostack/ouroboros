# Hosted Work Substrate

Ouroboros and Ouro now have a deliberate repo boundary.

- **Ouroboros** is this harness: local agent runtime, CLI, senses, tools, skills, bundle state, and Ouro Outlook.
- **Ouro** is the hosted agentic work substrate: agent-owned accounts, hosted mail ingress, vault control, shared work protocol, and cloud infra.

Hosted service source lives at [`ouroborosbot/ouro-work-substrate`](https://github.com/ouroborosbot/ouro-work-substrate).

## What Moved Out

The hosted repo owns:

- `packages/work-protocol`: shared mail registry, readable delegated aliases, key generation, private-envelope encryption, Screener placement, sender policy, account-lifecycle records, and machine-readable contracts. While the package remains private, harness-side copies must stay aligned with the canonical contracts in that repo.
- `apps/mail-ingress`: SMTP ingress, health endpoint, private-envelope parsing, encrypted local/Azure Blob storage, recipient rejection, and production container entrypoint.
- `apps/vault-control`: authenticated, rate-limited, domain-limited Vaultwarden account creation.
- `infra/azure`: Azure Container Apps, VNet-backed external TCP ingress shape, Blob Storage, managed identity, and role assignment.

## What Stays Here

This harness keeps:

- `ouro account ensure`, `ouro connect mail`, and `ouro mail import-mbox`.
- Local Mail sense orchestration and bounded mail tools.
- Agent vault coupling and runtime credential refresh.
- Ouro Outlook, including the read-only mailbox/audit UI.
- Local development stores and tests needed for agent runtime behavior.

Production account setup is controlled by the agent vault `runtime/config` item. When `workSubstrate.mode` is `hosted`, the harness reads `workSubstrate.mailControl.url` plus its bearer token, calls `POST /v1/mailboxes/ensure`, merges returned one-time private keys with existing vault-held keys, verifies every returned public mailbox/source key id is present, and stores hosted Blob reader coordinates on `mailroom`. If public hosted key ids are present but the matching private keys are missing from the vault, setup fails unless the agent explicitly passes `--rotate-missing-mail-keys`, which calls the hosted key-rotation endpoint and stores the fresh one-time keys. Rotation cannot recover already encrypted mail for the lost key. When hosted config is absent, `ouro connect mail` remains an explicit local-development setup and writes local registry/store paths instead of pretending to be production.

`ouro mail import-mbox` follows the same boundary. In local mode it reads the local registry/store paths. In hosted mode it reads the public registry from the configured Blob coordinates, streams the archive from disk into the encrypted Blob-backed Mailroom, and dedupes safely on rerun so large interrupted imports can be resumed without turning the whole archive into one transaction.

## Website

Website and marketing updates are intentionally deferred. Treat the hosted repo docs as the source of truth for product boundary language until a dedicated website pass happens.
