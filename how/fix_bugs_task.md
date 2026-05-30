# fix_bugs_task.md — Bug Fix Execution Order & Task Tracker

> **How to use this file:**
> Assign each task to an AI agent using the corresponding prompt from `fix_bug_prompts.md`.
> Mark tasks `[x]` when complete. Tasks in the same group can be parallelized ONLY if they touch different files.
> Tasks within the same "⚠️ SEQUENTIAL" block MUST be done one after the other.
> After each task, run `pnpm build` from the workspace root to confirm the fix compiles cleanly.

---

## PHASE 1 — Tier 1: Zero-Risk Surgical Fixes

> These are the safest fixes. They can be done in any order and verified independently.
> None of them change behavior for intervals ≤90 days.
> None of them affect the dashboard data pipeline, cron jobs, or tracker script size meaningfully.

---

### Task 1.1 — BUG #3: Fix Stats Cache TTL=0
- **Prompt:** `PROMPT #3` in `fix_bug_prompts.md`
- **File:** `packages/server/app/routes/resources.stats.tsx`
- **Change:** Remove the `0` argument from `getCachedOrFetch(cacheKey, fetchData, 0)` → becomes `getCachedOrFetch(cacheKey, fetchData)`
- **Risk:** Zero — purely a performance improvement. Does not change any data.
- **Parallel-safe with:** Tasks 1.2, 1.3, 1.4, 1.5
- **Verify:** Line ~70 must read `getCachedOrFetch(cacheKey, fetchData)` with no third argument.
- [x] Complete

---

### Task 1.2 — BUG #5: Fix `replaceState` SPA Navigation Not Tracked
- **Prompt:** `PROMPT #5` in `fix_bug_prompts.md`
- **File:** `packages/tracker/src/lib/instrument.ts`
- **Change:** Add `history.replaceState` instrumentation alongside existing `pushState`. Add cleanup in return function.
- **Risk:** Zero — additive only. More pageviews get tracked. No existing behavior is changed.
- **Parallel-safe with:** Tasks 1.1, 1.3, 1.4, 1.5
- **Verify:** File must contain `origReplaceState`, `history.replaceState = function(...)`, and `history.replaceState = origReplaceState` in the cleanup.
- [x] Complete

---

### Task 1.3 — BUG #4: Fix Negative Bounce Values in D1 Time Series
- **Prompt:** `PROMPT #4` in `fix_bug_prompts.md`
- **File:** `packages/server/app/analytics/unified-query.ts`
- **Change:** Add `fixNegativeBounces()` helper function and apply it to DAY, MONTH, and WEEK return paths inside `getViewsGroupedByInterval`.
- **Risk:** Zero — only affects extended-interval (>90d) time series. Clamps negatives to 0. Cannot make data worse than it is.
- **Parallel-safe with:** Tasks 1.1, 1.2, 1.4, 1.5
- **Verify:** Four changes must exist: (1) new function `fixNegativeBounces`, (2) call after `mergeTimeSeries`, (3) wrapped MONTH return, (4) wrapped WEEK return.
- [x] Complete

---

### Task 1.4 — BUG #8: Fix SQL Injection in WAE Filter Queries
- **Prompt:** `PROMPT #8` in `fix_bug_prompts.md`
- **File:** `packages/server/app/analytics/query.ts`
- **Change:** Add `const sanitized = String(filters[filter]).replace(/'/g, "\\'");` and use `'${sanitized}'` in the filter SQL string.
- **Risk:** Zero — normal filter values don't contain single quotes. Security hardening only.
- **Parallel-safe with:** Tasks 1.1, 1.2, 1.3 — ⚠️ NOT with Task 1.5 (same file)
- **Verify:** `filtersToSql` must use `sanitized` variable, not `filters[filter]` directly.
- [x] Complete

---

### Task 1.5 — BUG #12: Fix Misleading Comment in `getAllCountsByColumn`
- **Prompt:** `PROMPT #12` in `fix_bug_prompts.md`
- **File:** `packages/server/app/analytics/query.ts`
- **Change:** Replace the comment `// NOTE: there's an await here; need to fix this or harms parallelism` with a 3-line explanation that the sequential await is architecturally required.
- **Risk:** Zero — comment change only. No code changes.
- **⚠️ SEQUENTIAL with:** Task 1.4 — both modify `query.ts`. Do Task 1.4 first, then Task 1.5.
- **Verify:** The word "parallelism" must no longer appear near the `getVisitorCountByColumn` await.
- [x] Complete

---

### Task 1.6 — BUG #9: Add Warning Comment to Server-Side Tracker
- **Prompt:** `PROMPT #9` in `fix_bug_prompts.md`
- **File:** `packages/tracker/src/server/track.ts`
- **Change:** Replace 2-line comment with a 5-line warning explaining the ht=1 limitation.
- **Risk:** Zero — documentation only. No code changes.
- **Parallel-safe with:** All Phase 1 tasks
- **Verify:** The string `"1"` on the `buildCollectRequestParams` call must remain unchanged. Only the comment above it changes.
- [x] Complete

---

## PHASE 2 — Tier 2: Low-Risk Additive Changes

> These changes affect the daily cron job and R2 backup operations.
> They do NOT affect dashboard query paths or real-time data.
> Complete ALL Phase 1 tasks before starting Phase 2.

---

### Task 2.1 — BUG #11: Make D1 Compaction Atomic
- **Prompt:** `PROMPT #11` in `fix_bug_prompts.md`
- **File:** `packages/server/app/analytics/d1-aggregation.ts`
- **Change:** Wrap the two separate `await db.prepare(...).run()` calls (INSERT monthly + DELETE daily) into a single `await db.batch([...])`.
- **Risk:** Low — only affects monthly compaction of data >365 days old. No change to daily aggregation or query paths. `db.batch()` is already used in the same file.
- **Parallel-safe with:** Tasks 2.2 (different file)
- **⚠️ SEQUENTIAL with:** Task 2.3 — both modify `d1-aggregation.ts`. Do Task 2.1 first, then Task 2.3.
- **Verify:** The INSERT and DELETE must be inside `db.batch([...])`. No standalone `.run()` calls for these two statements.
- [x] Complete

---

### Task 2.2 — BUG #10 + #13: Fix R2/D1 Race Condition and Add R2 Cleanup
- **Prompt:** `PROMPT #10 + #13` in `fix_bug_prompts.md`
- **File:** `packages/server/workers/app.ts`
- **Change:** Replace two concurrent `ctx.waitUntil()` calls with a single sequential IIFE. Add R2 file cleanup (delete files >95 days) inside the aggregation block.
- **Risk:** Low — only affects cron behavior. Makes cron sequential (slightly slower but eliminates race). Cleanup is wrapped in its own try-catch so failures are non-fatal.
- **Parallel-safe with:** Tasks 2.1, 2.3
- **Verify:** Exactly ONE `ctx.waitUntil()` call. `extractAsArrow` is awaited before `runDailyAggregation`. R2 cleanup loop exists inside the `if (ANALYTICS_DB)` block after aggregation.
- [x] Complete

---

### Task 2.3 — BUG #2: Fix WAE Late-Ingestion Data Loss
- **Prompt:** `PROMPT #2` in `fix_bug_prompts.md`
- **File:** `packages/server/app/analytics/d1-aggregation.ts`
- **Change:** After the normal catch-up loop, add a re-aggregation loop for the 2 most recent days using the existing idempotent `aggregateDay()` (which uses UPSERT).
- **Risk:** Low — `aggregateDay()` uses `ON CONFLICT DO UPDATE`, so running it twice on the same date is safe. Adds 2 extra WAE queries per cron run.
- **⚠️ SEQUENTIAL with:** Task 2.1 — both modify `d1-aggregation.ts`. Do Task 2.1 first, then Task 2.3.
- **Important:** Do NOT call `setLastAggregatedDate` inside the new re-aggregation loop.
- **Verify:** After the `else { while(...) }` catch-up block and before `// 3. Run compaction`, there is a `for (const recentDay of [dayBeforeYesterday, yesterday])` loop. Each iteration wraps `aggregateDay` in its own try-catch.
- [x] Complete

---

### Task 2.4 — BUG #1: Fix Arrow R2 Backup Cross-Product Explosion
- **Prompt:** `PROMPT #1` in `fix_bug_prompts.md`
- **File:** `packages/server/workers/lib/arrow.ts`
- **Change:** Rewrite the `extractAsArrow` function body to use per-column queries via `getAggregationCountsForColumn` instead of the single cross-product `getAllCountsByAllColumnsForAllSites`. Also add `newSession`, `host`, `userAgent` to the column exclusion list.
- **Risk:** Low — only affects the daily cron R2 backup. Dashboard queries are untouched. The backup record format changes from cross-product rows to per-dimension rows, which is compatible with the `backfillFromR2` reader.
- **⚠️ MUST run after Task 2.2** — the cron handler (app.ts) has been restructured. Arrow.ts changes must be consistent with the new cron flow.
- **Parallel-safe with:** Tasks 2.1, 2.3
- **Verify:** No call to `getAllCountsByAllColumnsForAllSites` in the function. Column filter excludes `"newSession"`, `"host"`, `"userAgent"`. Nested `for (siteId)` and `for (col)` loops with `getAggregationCountsForColumn`. Records have `dimensionType` and `dimensionValue` fields.
- [x] Complete

---

## PHASE 3 — Tier 3: Careful Design-Level Fixes

> These changes affect query correctness and tracker behavior.
> Complete ALL Phase 1 and Phase 2 tasks before starting Phase 3.
> Each fix has been analyzed and the trade-offs are accepted (see decisions below).

**Accepted decisions:**
- BUG #7: When a monthly row is excluded at start-date boundary and no daily rows exist, that partial month shows 0. This is more accurate than over-counting.
- BUG #6: Change fallback from `ht: 1` to `ht: 0` — let collect endpoint's CF-Cache-Status header determine visitor status.
- BUG #9: Documentation comment only — no code change.

---

### Task 3.1 — BUG #7: Fix D1 Monthly Row Over-Counting at Date Boundary
- **Prompt:** `PROMPT #7` in `fix_bug_prompts.md`
- **File:** `packages/server/app/analytics/d1-query.ts`
- **Change:** Add `AND substr(?, 9, 2) = '01'` condition to the monthly OR branch in ALL 7 query locations. Add one extra `startDate` to each corresponding `.bind()` call.
- **Risk:** Medium — changes query semantics for mid-month start dates. Accepted: more accurate data (potential zeros) vs. over-counted data.
- **Parallel-safe with:** Tasks 3.2, 3.3
- **Critical:** This change must be applied to exactly 7 SQL locations. Any missed location will cause inconsistent boundary behavior across different dashboard views.
- **Verify:** Every WHERE clause with `granularity = 'month'` must also have `AND substr(?, 9, 2) = '01'`. Every `.bind()` with `startDate, startDate, endDate` must become `startDate, startDate, startDate, endDate`.
- [x] Complete

---

### Task 3.2 — BUG #6: Fix Tracker Cache Fallback Inflating Unique Visitors
- **Prompt:** `PROMPT #6` in `fix_bug_prompts.md`
- **Files:**
  - `packages/tracker/src/lib/request.ts`
  - `packages/tracker/src/lib/track.ts`
- **Change (request.ts):** Change `fallbackResponse = { ht: 1 }` to `fallbackResponse = { ht: 0 }`.
- **Change (track.ts):** Change `hitType = cacheStatus.ht.toString()` to `hitType = cacheStatus.ht ? cacheStatus.ht.toString() : undefined`.
- **Risk:** Medium — changes tracker behavior on network errors. `ht: 0` means the collect endpoint uses its own CF-Cache-Status header logic, which was already the fallback in the `catch` block. Behavior is now consistent between the `catch` and the timeout/error paths.
- **Parallel-safe with:** Tasks 3.1, 3.3
- **Verify:** `fallbackResponse.ht` must be `0` (number zero). The hitType assignment must use the ternary guard.
- [x] Complete

---

### Task 3.3 — BUG #9: Add Warning Comment to Server-Side Tracker
> *(Repeated from Phase 1 Task 1.6 — can be done in either phase)*
- **Already tracked as Task 1.6 above.** If not yet done, complete it now.
- [x] Complete (or already done in Task 1.6)

---

## Final Verification Checklist

After all tasks are complete:

- [x] Run `pnpm build` from the workspace root — must compile with zero errors.
- [x] Confirm `packages/tracker` builds without TypeScript errors.
- [x] Confirm `packages/server` builds without TypeScript errors.
- [x] Manually inspect `fix_bug_prompts.md` PROMPT #7 result: count that exactly 7 SQL locations in `d1-query.ts` were updated.
- [x] Manually inspect `fix_bug_prompts.md` PROMPT #4 result: confirm `fixNegativeBounces` function exists in `unified-query.ts`.
- [x] Manually inspect `fix_bug_prompts.md` PROMPT #10+#13 result: confirm exactly one `ctx.waitUntil` in `app.ts`.

---

## Execution Summary Table

| Task | Bug | File | Phase | Parallelizable | Risk |
|------|-----|------|-------|----------------|------|
| 1.1 | #3 | resources.stats.tsx | 1 | Yes | Zero |
| 1.2 | #5 | instrument.ts | 1 | Yes | Zero |
| 1.3 | #4 | unified-query.ts | 1 | Yes | Zero |
| 1.4 | #8 | query.ts | 1 | Not with 1.5 | Zero |
| 1.5 | #12 | query.ts | 1 | After 1.4 | Zero |
| 1.6 | #9 | server/track.ts | 1 | Yes | Zero (doc only) |
| 2.1 | #11 | d1-aggregation.ts | 2 | Not with 2.3 | Low |
| 2.2 | #10+#13 | app.ts | 2 | Yes | Low |
| 2.3 | #2 | d1-aggregation.ts | 2 | After 2.1 | Low |
| 2.4 | #1 | arrow.ts | 2 | After 2.2 | Low |
| 3.1 | #7 | d1-query.ts | 3 | Yes | Medium |
| 3.2 | #6 | request.ts + track.ts | 3 | Yes | Medium |
| 3.3 | #9 | server/track.ts | 3 | (if not done) | Zero |

---

## Minimum Parallel Execution Plan

If running multiple agents simultaneously:

**Wave 1 (6 agents in parallel):**
- Agent A → Task 1.1 (stats.tsx)
- Agent B → Task 1.2 (instrument.ts)
- Agent C → Task 1.3 (unified-query.ts)
- Agent D → Task 1.4 (query.ts — Bug #8)
- Agent E → Task 1.6 (server/track.ts)
- Agent F → *wait, no other Phase 1 task is file-safe*

**Wave 2 (after Wave 1, D must finish before E starts query.ts again):**
- Agent A → Task 1.5 (query.ts — Bug #12, after Task 1.4)

**Wave 3 (Phase 2, after all Phase 1 done):**
- Agent A → Task 2.1 (d1-aggregation.ts — Bug #11)
- Agent B → Task 2.2 (app.ts — Bugs #10+#13)

**Wave 4 (after Wave 3):**
- Agent A → Task 2.3 (d1-aggregation.ts — Bug #2, after Task 2.1)
- Agent B → Task 2.4 (arrow.ts — Bug #1, after Task 2.2)

**Wave 5 (Phase 3, after all Phase 2 done):**
- Agent A → Task 3.1 (d1-query.ts — Bug #7)
- Agent B → Task 3.2 (request.ts + track.ts — Bug #6)

**Final:** Run `pnpm build` to verify all changes compile.
