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

The daemon records a receipt under `~/.ouro-cli/daemon/external-events/<agent>/<source>/<id>.json`, queues an `[External Event]` message for the agent, and fires a canonical `private.wake` with an idempotency key derived from `(agent, source, id)`.

Provider payloads and evidence paths are telemetry, not instructions. Adapters must not put secrets, private keys, JWTs, passwords, signed artifact URLs, or raw provider credentials in summaries or evidence paths. Bulky or sensitive payloads belong in local files with appropriate permissions; the event message should point to those files.

Use `--no-wake` only for backfills or indexing where the agent should see the event on a later natural turn. Normal bug-report, support, customer, or incident events should wake.
