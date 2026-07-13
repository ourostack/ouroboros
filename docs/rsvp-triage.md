# RSVP Habit Triage

Use this when an agent's configured RSVP habit looks wrong, misses context, sends at the wrong time, or needs a no-send incident bundle.

## Fast Check

```bash
ouro status --json
ouro rsvp doctor --agent <agent> --json --strict
```

Start with live runtime truth, not old files. `ouro status --json` tells you whether the daemon and senses are running. `ouro rsvp doctor --agent <agent> --json --strict` checks native RSVP config, configured source readiness, BlueBubbles attachment, context packet ledgers, latest fetch, delivery reconciliation, spend/run ledgers, habit schedule, and cutover safety without sending messages.

## Incident Bundle

```bash
ouro rsvp incident --agent <agent> --output /tmp/rsvp-incident.json --json
```

The incident bundle is a redacted local summary. It should name failing checks, latest RSVP/context state, receipt locations, and sanitized cutover status. Do not paste raw chat GUIDs, BlueBubbles URLs, cookies, or credentials into notes, issues, PRs, or chat.

## Replay Before Live

```bash
ouro rsvp replay --fixture src/__fixtures__/rsvp/july-9-context/manifest.json --agent <agent> --json
ouro rsvp legacy-render --legacy-root <legacy-rsvp-root> --output /tmp/rsvp-legacy.json --json
ouro rsvp refresh --agent <agent> --mode shadow --no-send --output /tmp/rsvp-shadow.json --json
ouro rsvp smoke --agent <agent> --mode preflight --surface bluebubbles --question "who is pending?" --output /tmp/rsvp-preflight.json --json
```

Replay fixtures must stay repo-safe: `searchIndex: false`, `vectorIndex: false`, no raw live transcript, and no credential material. Shadow refreshes and preflight smokes are no-send paths. They should prove the agent can answer RSVP follow-ups from native context/state before any live BlueBubbles send.

## Evidence Locations

- `state/senses/context-packets`: context packets and ledgers used to bundle same-sense history into the next turn.
- `state/senses/bluebubbles/outbound`: idempotency, route proof, attachment proof, retry, and delivery receipts for BlueBubbles sends.
- `state/rsvp`: native RSVP snapshots, baselines, imports, diffs, and refresh artifacts.
- `arc/flight-recorder`: habit and runtime receipts that explain when a habit ran and what it observed.

If these disagree, treat doctor/incident output as the index and inspect only the named files. Avoid directory-wide dumps in bug reports.

## Cutover Safety

Before live native send, verify the legacy sender is inactive and native BlueBubbles credentials still work:

```bash
ouro rsvp cutover --agent <agent> --legacy-root <legacy-rsvp-root> --action check --json
```

Live RSVP smoke is allowed only after the check proves the LaunchAgent, running legacy process, legacy send config, and legacy live-send path are inactive. Keep rollback notes with the cutover artifact rather than relying on memory.
