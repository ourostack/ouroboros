# Trip ledger

The trip ledger is a structured, encrypted-at-rest record of a real-world
trip — the kind of trip that has flights, hotels, and itineraries
attached to it. It exists because the agent kept losing facts when
working from mail alone.

## Why this exists

Slugger named the gap during a planning conversation in April 2026:

> "Today, doc-edits-from-mail keep falling back on freeform parsing
> because there is no structured object between 'mail body' and 'travel
> doc'. The agent infers facts and edits prose; the moment a date is
> misread or a confirmation is ambiguous, there is no authoritative
> source to cross-check against."

The trip ledger is that authoritative source. When Ari forwards a
booking confirmation, Slugger extracts the structured facts (dates,
confirmation codes, traveller names, amounts) into a `TripRecord` whose
provenance is traceable back to the source mail message. Future edits,
cross-references, and itinerary builds all read from the ledger, not
from re-parsed mail bodies.

## What it is, concretely

A **TripRecord** is one trip. It has:

- `tripId` — deterministic id derived from `agentId + name + createdAt`
- `name`, `status` (planning / confirmed / underway / closed / cancelled),
  optional `startDate` / `endDate`
- `travellers` — array of `TripParty` (names, sometimes loyalty IDs)
- `legs` — array of `TripLeg` (the actual flights / hotels / etc.)
- `notes` — freeform operator notes
- `createdAt` / `updatedAt`

A **TripLeg** is a discriminated union over `kind`:

- `lodging` (hotel / Airbnb)
- `flight`
- `train`
- `ground-transport` (taxi, transfer, rideshare)
- `rental-car`
- `ferry`
- `event` (concert, conference session, restaurant)

Each leg carries fields appropriate to its kind (a flight has
`flightNumber`, a hotel has `checkInDate` / `checkOutDate`, etc.) plus
universal fields: `legId`, `status`, optional `vendor`, optional
`confirmationCode`, optional `amount`.

Every leg also carries an `evidence` array — `TripEvidence[]` — where
each entry is non-optional provenance:

- `messageId` — the source mail message id (or `operator-direct` for
  facts the operator stated verbally)
- `reason` — short human-readable note ("booking confirmation",
  "rebooked after cancellation")
- `recordedAt` — when the agent recorded this fact
- `discoveryMethod` — `extracted` (parsed from mail), `inferred`
  (deduced from itinerary gap), or `operator_supplied` (Ari said so)
- `excerpt?` — optional snippet from the source

The provenance is what makes the ledger trustworthy. Any fact in any
leg can be traced back to the message (or operator interaction) that
produced it.

## Is it travel-specific or general infrastructure?

**The current shape is travel-specific.** The leg-kind enum names real
travel artifacts; the date semantics (start/end, check-in/check-out)
are travel-shaped; the amount field assumes the granularity of a single
booking.

**But the *pattern* is general.** If we ever build:

- a *project ledger* — tied to commits, PRs, tickets — with evidence
  pointing at source artifacts,
- a *transactions ledger* — purchases, returns, refunds —
- a *health ledger* — medical visits, prescriptions —
- or any other "structured facts with provenance" record,

we would reuse the encryption envelope, the per-agent key registry,
and the evidence-with-discoveryMethod shape. Each new ledger gets its
own discriminated union of "leg kinds" (or whatever the equivalent
unit is) and its own service-side validation, but the trust shape and
crypto layer carry over directly.

We have **not** extracted that abstraction yet, by design. YAGNI: the
right time to generalize is when we have a second concrete use case
that proves which fields are universal and which are travel-only. The
mail substrate followed the same path — `mail-control` was built
shape-first, and only later did we lift its envelope (RSA-OAEP-SHA256
+ AES-256-GCM) into the shared pattern that the trip ledger now
re-uses.

If you read `apps/trip-control/` and `apps/mail-control/` side by
side, you'll see the convergent pattern: bearer-token auth, per-IP
rate limiting, atomic file-backed local store, AzureBlob backing with
optimistic etag concurrency for the registry, structured JSON-line
logging. That's the substrate's preferred shape for any
"per-agent encrypted record" service.

## Trust shape

Mirrors the mail substrate exactly:

- The **hosted side** publishes the per-agent ledger public key in a
  registry (one ledger per agent in v1).
- The **private key** is returned exactly once by
  `ensureAgentTripLedger()` on first creation, then never again.
- Every `TripRecord` is stored encrypted with the agent's ledger key.
  The hosted side never sees plaintext trip facts.
- The harness vendor-copies the encryption types so it can decrypt
  records locally without runtime dependency on the hosted service.

## Harness tools

The agent has eight tools for working with the ledger
(`src/repertoire/tools-trip.ts`):

| Tool | Purpose |
| --- | --- |
| `trip_ensure_ledger` | Idempotently provision the agent's keypair on disk. Safe to call at every boot. |
| `trip_status` | List known trip ids in sorted order. Cheap overview. |
| `trip_get` | Read + decrypt one trip by id. Returns a structured summary plus the raw JSON. |
| `trip_upsert` | Create or replace a whole `TripRecord`. Validates shape before persisting. |
| `trip_update_leg` | Update specific fields of an existing leg without re-emitting the whole record. Cannot change `legId` or `kind`. |
| `trip_attach_evidence` | Append a `TripEvidence` entry to a specific leg's evidence array. The natural follow-up to "I just extracted a fact from a mail message and need to remember where it came from." |
| `trip_calendar` | Render a chronological calendar/agenda projection from ledger legs, preserving leg status and evidence ids so mail-derived plans are trackable over time. |
| `trip_new_id` | Compute a deterministic trip id from `agentId + name + createdAt`. Useful before constructing a new record so the id is stable. |

All eight tools gate behind the same trust check used by other private
surfaces (mail, vault): only callers in trusted contexts (operator
loopback, family friend records) can invoke them.

## On-disk layout (harness side)

```
state/trips/
  ledger.json                 # the agent's keypair record
  records/
    <tripId>.json             # one encrypted TripRecord per trip
```

`ledger.json` is the only file containing the private key. Treat it
like any other secret material — the bundle's normal access controls
apply.

## Hosted layout (trip-control service)

```
trips/                        # Azure Blob container or local filesystem
  registry/
    ledgers.json              # public-key registry (etag-concurrent)
  agent/<agentId>/
    <tripId>.json             # encrypted TripRecord blobs
```

The registry uses optimistic etag concurrency control identical to
`AzureBlobMailRegistryStore` — first write requires `ifNoneMatch: "*"`,
subsequent writes require `ifMatch: <etag>`, retried up to 3 times.
Trip blobs themselves are last-write-wins because each trip is owned
by a single agent.

## Why local-first today

The harness reads/writes trips on local disk via `state/trips/`. The
substrate's hosted `trip-control` service is provisioned and runs in
Azure (with the `AzureBlobTripLedgerStore` and etag concurrency for the
registry), but the harness tools don't talk to it yet. This is
**deliberate**, not an oversight:

- Slugger currently runs on a single machine, so cross-machine sync
  isn't a real benefit yet.
- Local-first means trips work even when the hosted service is down
  or unreachable, matching the harness's general posture toward
  external services.
- The on-disk envelope is byte-for-byte compatible with the hosted
  format, so a future migration is a straightforward swap of the
  `TripLedgerStore` factory in `src/trips/store.ts` — no data shape
  change required.

The cleanest moment to wire harness → hosted is when Slugger first
needs to read his ledger from a second machine. At that point the
work is: add an `AzureBlobTripStore` parallel to
`AzureBlobMailroomStore`, add the trip-control coordinates to runtime
config (the same pattern as mailroom), and swap the factory. The
mail substrate has trodden this exact path, so the work is
mechanical rather than design.

## On extending to a second ledger domain

If a *second* per-agent encrypted record service ever shows up — a
transactions ledger for travel spend is the most likely candidate —
the shared pattern wants to lift to a common abstraction:

- the encryption envelope (RSA-OAEP-SHA256 + AES-256-GCM)
- the per-agent registry with etag concurrency
- the bearer-token + rate-limit + atomic-write HTTP shape
- the evidence-with-`discoveryMethod` record shape

Until that second use case exists, both the trip ledger and the mail
substrate keep their own copies. The right time to extract is when a
third use case proves which fields are universal — not before.

If you're extending this and feel the abstraction wants to escape the
travel domain, talk to Slugger first. He is the inhabitant.
