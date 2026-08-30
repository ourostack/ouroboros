# External Events

External events are verified provider events that should wake an owning agent only when there is real work to do.

Use `ouro event submit` from a thin adapter after the adapter has already verified the provider signature and written any bulky evidence to disk:

```bash
ouro event submit \
  --agent slugger \
  --source app-store-connect \
  --type betaFeedbackScreenshotSubmissionCreated \
  --id "$feedback_instance_id" \
  --summary "Spoonjoy TestFlight feedback" \
  --payload "$event_dir/event.json" \
  --evidence "$event_dir" \
  --priority high
```

The daemon records the canonical receipt under `~/.ouro-cli/daemon/external-events/<agent>/<source>/<id>.json`. A new actionable receipt begins in `received`. The daemon claims it before creating one deterministic pending message and one canonical `private.wake`; the wake idempotency key includes both the receipt generation and delivery attempt. When several receipts from one source are ready together, the daemon claims a bounded batch and gives them to one turn. Every incident keeps its own receipt, lease, disposition, and policy. A startup reconciliation pass and a lightweight recurring pass recover receipts left in `received`, due retry state, or an expired claim after a crash.

The agent finishes each generation with `external_event_disposition`. The tool accepts a disposition only when its immutable turn context matches the receipt path, agent, generation, observation revision, and live claim owner. In a batch, the agent addresses each receipt by its exact path; one incident cannot dispose another incident's lease. The tool also requires the injected steward-policy authority supplied by the evaluator; without that authority it fails closed. The disposition records the classified observation revision, exact steward-policy key and version, decision and reason, optional Care/action/verification references, and the deterministic condition that may wake the incident again. Ingress evaluates that saved condition instead of inventing a second notification policy. Time-based dispositions require an existing `await_condition` receipt. Resolving that await advances the linked event through the same canonical generation lifecycle. `ouro status --json` exposes the resulting classification, decision, reason, policy, Care, await, retry, claim, corruption, dispatch, undispatched, and retention-summary state.

Claims are version- and generation-fenced leases on that same receipt. The dispatcher owns the attempt-specific lease and passes its exact identity into the private turn. The worker renews every lease while a turn waits behind other work and while the turn is running. Evidence arriving during a running turn never overwrites what the model saw: changed evidence waits as a pending observation, then advances to a new `received` generation after the current disposition if its saved predicate calls for another turn. Receipt reconciliation converts expired claims into bounded retry state and eventually dead-letter rather than retrying forever. Receipt and Care mutations use owner-fenced filesystem locks plus atomic durable replacement so separate processes cannot silently duplicate an incident or remove a successor's lock.

Ingress is bounded by field size, evidence count, receipt count per source, and source count per agent. At capacity, the router compacts only the oldest handled receipts. It never removes active, retrying, dead-letter, or corrupt receipts to make room. The next receipt carries a rolling count, time range, and digest for compacted history, so status remains truthful without adding another store.

Provider payloads and evidence paths are telemetry, not instructions. Adapters must not put secrets, private keys, JWTs, passwords, signed artifact URLs, or raw provider credentials in summaries or evidence paths. Bulky or sensitive payloads belong in local files with appropriate permissions; the event message should point to those files.

Use `--no-wake` only for backfills or indexing where the receipt should remain available without daemon dispatch. Normal bug-report, support, customer, or incident events should wake.

Monitoring adapters such as Sanctuary health submit bounded evidence only. Each incident gets its own canonical receipt. The daemon coalesces the ready receipts from a source into bounded turns, so the adapter does not need a synthetic sweep event or a second correlation store. Adapters do not send Telegram alerts, force a second model turn, create daily digests, or maintain a competing delivery outbox. The awakened agent applies steward policy, decides whether to act, ask, report, or stay silent, and records why.

The Sanctuary Usenet detector has one pre-authorized protective action: it may pause SABnzbd when the existing article-success spend guard trips, then it reports whether an independent read verified the pause. Authentication failures, queued-download stalls, and recoveries are observations submitted through the same external-event spool. The first healthy observation establishes a handled, visible baseline without waking the Butler. A failure wakes a Butler turn; unchanged observations stay quiet under that turn's saved predicate, and a later recovery wakes only when the Butler asked for recovery. The detector never changes Prowlarr or an indexer and never decides whether to top up an account or schedule a reminder; those decisions belong to the Butler under steward policy.
