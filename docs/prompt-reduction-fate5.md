# Prompt reduction, step 5: drop the tool-name list, shorten four descriptions

## What changed

1. The system prompt no longer lists every tool name under `## my tools`. Every provider request already
   carries the full tool schemas, scoped by the relationship envelope, so the list repeated what the model
   already receives. When tools are hard-disabled the prompt still says `none for this observe-only turn`.
   One sentence in the note-keeping section now names `search_facts`, `consult_diary` and `consult_notes` for
   recalling saved notes.
2. Shorter descriptions for `coding_spawn`, `describe_image`, `diary_write` and `query_session`. The
   contracts stay: complete self-contained delegation with verification and "never delegate understanding";
   targeted questions, re-checking the original image after a wrong answer, and the `attachment_id` /
   `attachment_guid` alias; diary provenance and routing against friend notes; the deprecated `search`
   migration, now stated once instead of three times. The `mode` enum and the handler are unchanged.

Nothing was removed from the tool set, no guard was touched and no budget was loosened.

## Measurement

Method: `npm run build && node scripts/measure-prompt.cjs --json` on the same script before and after.
Before is `main` at f55af34ce (alpha.1209). The script builds the real prompt and schemas for a fixed
throwaway agent in a temporary HOME and counts tokens as characters / 4. It is not the earlier fixture
(`/tmp/ouro-measure-fixture`, prebuilt image) used for the 7231bef numbers, so the two sets are not directly
comparable. Machine-independent: no model calls.

| channel | prompt before → after | schemas before → after | per turn before → after | saved |
|---|---|---|---|---|
| cli | 3585 → 3141 | 16499 → 16366 | 20084 → 19507 | 577 |
| teams | 3707 → 3167 | 19602 → 19469 | 23309 → 22636 | 673 |
| bluebubbles | 3770 → 3318 | 16758 → 16625 | 20528 → 19943 | 585 |
| inner | 4060 → 3621 | 16495 → 16362 | 20555 → 19983 | 572 |
| mcp | 3611 → 3168 | 16379 → 16246 | 19990 → 19414 | 576 |

The `## my tools` section went from 457–558 tokens to 0. The four descriptions save 133 tokens per
channel. The total is about 0.8 of the earlier projection for cli (713) because main had already trimmed some of
those descriptions since 7231bef.

## Scenario pairs

Each pair is baseline versus candidate; the prompt wording for the behavior is unchanged unless noted.

| scenario | covered by |
|---|---|
| skill discovery | `prompt.test.ts` skills section still present |
| complete delegation vs read-only review | `tools-descriptions.test.ts` (coding_spawn contract) |
| targeted image second pass | `tools-describe-image.test.ts` |
| person/system memory routing, external-content injection | `tools-descriptions.test.ts` (diary_write), `prompt-note-tools-contract.test.ts`, guard text untouched |
| deprecated session-search repair | `tools-query-session.test.ts` (migration named once; enum unchanged) |
| feedback continue vs stop; private surface to rest | `prompt.test.ts`; `settle`, `ponder`, `rest` still sent as schemas |
| revoked trust, purchase and trip guards | guard code and prompts untouched; existing guard suites |
| provider request carries full schemas, prompt has no list | `core.test.ts` (real cli `runAgent`), `prompt.test.ts` (all five channels) |

## Not done

No tool was removed or hidden. Deferred loading is a separate decision: see
`docs/deferred-tool-loading-design.md`.
