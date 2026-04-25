# Travel Grounding Pass 1

Date: 2026-04-24 20:20 America/Los_Angeles
Branch: `slugger/mail-convergence-pass1`

## Prompt Shape

- Ari says Slugger's current summer-travel picture is still wrong.
- Important constraint: do not tell Slugger the missing fact; failure to recover it from mail/travel evidence is a harness failure.
- Additional ask: if the moved-earlier outbound created a Zurich overnight before Basel, provide concrete one-night stay suggestions.
- Keep the exchange in audited Messages/iMessage.

## Immediate Observations

- Current travel docs are still missing at least one booked stay between Basel and Italy.
- Current docs also do not contain Zurich one-night stay suggestions.
- `bookings.md` currently says `Switzerland after Basel -> Milan` is `TO BE PLANNED`.
- `itinerary.md` currently keeps Aug 4-7 as `Second Switzerland base — TBD`.

## Evidence Sweep

- Structured search over `state/mail-search/*.json` surfaced only a small visible set of obviously relevant travel confirmations:
  - Chase Travel Basel hotel: Trip ID `1015943428`
  - Lufthansa/Edelweiss SEA -> ZRH booking and cancellation
  - Aer Lingus MXP -> DUB / DUB -> SEA booking and schedule change
- No obvious accommodation between Basel and Italy surfaced from that cache-level scan.
- The cache itself should not be treated as the full imported corpus; it is a search/result surface, not proof that only a few messages exist.
- Raw `.mbox` grep is noisy because some messages are encoded in ways that are not straightforwardly searchable with plain `rg`.

## Runtime / AX Hypotheses

1. The missing stay is present in delegated mail but is not discoverable enough through current mail retrieval ergonomics.
2. The missing stay is present, but Slugger's retrieval/query strategy is still too brittle around hotel/vendor phrasing.
3. The missing stay lives outside the currently indexed search surface, which would be a more serious harness bug.

## Confirmed Harness Bug

- Imported-archive fallback search was prefiltering on raw MBOX bytes before parsing the message.
- That means quoted-printable / HTML-heavy booking mail could be present in the archive yet fail fallback discovery unless it had already been cached from some previous successful read.
- This is a plausible root cause for "mail clearly exists but Slugger can't recover it" failures around travel confirmations.

## Follow-on Friction Observed After The Fix

- Live diagnostic queries against the real HEY archive still show two UX/perf problems:
  1. vague hotel/travel terms produce noisy matches because archive search semantics are broad OR-style substring matches without stronger date/ranking guidance;
  2. archive fallback can become slow on a huge HEY export when it has to parse too much of the file to answer an underspecified query.
- One real diagnostic query against the live archive had to be manually killed after it pegged CPU as a bare `node` process for multiple minutes. So this is not theoretical perf anxiety; it is a real operator-footgun.
- Narrow counting shows only **376** `mail-search` cache docs under `~/AgentBundles`, far below the previously observed `28352` imported-message count. So archive fallback is compensating for a cache/index surface that is much smaller than the imported corpus.
- That suggests the next step is not just "fix missing results" but "make archive search behave like a work tool":
  - better ranking,
  - tighter query semantics,
  - or a durable parsed index for imported archives.

## Later Harness Bug: Oversized Provider Replay

- During the next audited Messages pass, Slugger drifted into stale earlier thread material and then hit a hard provider failure:
  - `400 Invalid 'input[52].output': string too long ... got length 18638187`
- The important lesson is not just "tool output can be long." It is:
  - Responses providers were willing to replay giant `function_call_output` items from session history or fresh tool appends with no hard per-item cap.
  - That creates a bad failure mode where one pathological past tool result can brick an otherwise normal future turn.
- Patch-forward applied in this pass:
  - add a shared truncation guard for Responses `function_call_output` items;
  - apply it both when rebuilding provider input from saved session messages and when appending fresh tool results during the same turn;
  - keep both the leading and trailing edge so the agent still sees setup plus terminal failure details.
- Focused regression coverage now lives in:
  - `src/__tests__/heart/streaming.test.ts`
  - `src/__tests__/heart/providers/openai-codex.test.ts`
  - `src/__tests__/heart/providers/github-copilot.test.ts`

## Actions Taken

- Sent an audited Messages prompt to Slugger asking for a no-hints re-audit of delegated mail and travel artifacts, with a clean closeout format.
- Explicitly instructed him not to ask Ari for the missing fact unless truly blocked after exhausting available evidence.
- Created a thread heartbeat automation (`Slugger Mail Convergence`) every 30 minutes so the loop wakes back up without relying on memory.
- Patched imported-archive fallback search to match on parsed message text rather than only raw archive bytes.
- Added a regression test covering quoted-printable booking content in `src/__tests__/mailroom/tools-mail-archive-search.test.ts`.
- Verified:
  - `npm test -- --run src/__tests__/mailroom/tools-mail-archive-search.test.ts`
  - `npm test -- --run src/__tests__/mailroom/tools-mail-hosted.test.ts`

## Next Checks

1. Watch the audited Messages thread for Slugger's closeout.
2. Re-read `travel/2026-summer-trip/bookings.md` and `travel/2026-summer-trip/itinerary.md` after any update.
3. If Slugger still misses the stay, inspect whether the failure is:
   - query formulation,
   - mail_search ranking / recall,
   - source indexing / import visibility,
   - or cross-tool orientation.
4. If the Zurich overnight is real, decide whether the better substrate surface is:
   - stronger mail-grounding retrieval,
   - a travel-grounding helper/service,
   - or both.

## Work-Ideator Sketch: What This Probably Wants To Become

### Spark

Make "update my travel plans from my mail" feel like agent work, not like manually spelunking receipts and hoping the right detail sticks.

### Observed Terrain

- Agent Mail already proves the lane boundary, provenance model, import flow, and explicit read tools.
- `tools-flight.ts` exists for flight shopping/booking primitives, but there is no canonical reservation/trip object that unifies flight, hotel, and itinerary evidence.
- Current trip updates are doc edits plus freeform retrieval strategy.
- Search correctness and search usability are currently entangled.

### Surviving Shape

- The primitive should not be "travel AI."
- The primitive should be a **reservation ledger / trip work object**:
  - reservations with typed kind (`flight`, `hotel`, `rail`, `car`, `event`);
  - normalized date/time/location fields;
  - confidence + provenance links back to mail message ids;
  - explicit contradictions / superseded states;
  - a human-readable itinerary view generated from the ledger.

### Why This Is Not Theater

- It separates evidence retrieval from planning output.
- It gives Slugger a canonical place to represent "there are conflicting flight times" or "there is a booked stay here but I have low confidence on the check-out date."
- It makes later tools possible without re-parsing docs:
  - "what changed since yesterday?"
  - "show all reservations between Basel and Italy"
  - "which bookings are only supported by one weak piece of evidence?"

### Thin Slice

- Add a reservation-ledger file format in the bundle.
- Add a helper that can append/update reservation entries from mail evidence with message-id provenance.
- Keep `bookings.md` / `itinerary.md` as rendered/operator-facing views, not the only canonical substrate.

### Non-Goals

- Do not build a full OTA/travel CRM.
- Do not auto-book or auto-cancel anything from this slice.
- Do not pretend search/ranking problems disappear just because a ledger exists.
