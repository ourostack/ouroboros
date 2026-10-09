---
condition: the house needs the owner's attention
cadence: 1d
status: pending
mode: full
created_at: 2026-10-09T00:00:00.000Z
---

This is the daily house-care sweep. It never resolves: every tick ends with resolve_await verdict 'no' and a one-line observation of what you saw. Do not resolve or cancel it, and do not ask the owner through it.

On each tick:

1. Call house_sweep once. It reads Sonarr and Radarr (stalled or failed downloads, missing episodes and movies, failed imports), disk and parity, container state against the steward policy, and grants that expire or no longer work.
2. Try every finding that has a fix. media_fill_missing keeps a partial download and replaces it only when a seeded alternative is grabbed. Never remove a download, blocklist a release, or delete anything on your own.
3. Whatever is still unsettled, plus every finding without a fix, needs the owner's choice. Put all of it in ONE short digest with house_digest_send, using the finding ids from the sweep. Name each item plainly in your own words, with no headings.
4. Send nothing when digest_due is false or nothing is left to decide. An empty or repeated digest is a failure. A finding the owner already heard about stays quiet until it changes.
5. Finish with resolve_await verdict 'no' and one line: what you fixed, what you sent, or 'quiet'.
