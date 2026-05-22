# migrate-bundle-mini

Synthetic fixture bundle for `src/heart/daemon/migrate-to-desk.ts` tests
(W6 Unit 11). Covers all five classification buckets:

| Path under `tasks/`                                                   | Bucket               |
|------------------------------------------------------------------------|----------------------|
| `one-shots/2026-04-15-doing-done-feature.md`                          | terminal             |
| `one-shots/2026-04-15-planning-done-feature.md`                       | terminal (paired)    |
| `archive/2026-04-25/2026-03-07-archived-thing.md`                     | terminal (archive/)  |
| `one-shots/2026-03-01-doing-old-but-live.md`                          | stale_live           |
| `one-shots/2026-04-29-junk-no-status.md`                              | ambiguous            |
| `one-shots/2026-05-12-1122-doing-rest-loop-incident.md`               | live_clear           |
| `one-shots/2026-05-12-1122-planning-rest-loop-incident.md`            | live_clear (paired)  |
| `one-shots/2026-05-12-1122-doing-rest-loop-incident/baseline.md`      | live_clear (child)   |
| `one-shots/2026-05-12-1122-doing-rest-loop-incident/log.txt`          | live_clear (non-md)  |
| `ongoing/2026-03-09-1410-summer-2026-europe-trip.md`                  | special_europe_trip  |

The "today" reference date used by the migrator is 2026-05-22, so the
30-day cutoff is 2026-04-22 (anything `updated` earlier is stale_live).
