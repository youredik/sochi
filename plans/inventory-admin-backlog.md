# Inventory admin — backlog (status, not instructions)

Open items NOT shipped в 2026-05-14 closure. Framed как status per
`/transfer-context` skill wording rule (May 2026 canon): «X is not yet
implemented» NOT «do X next».

## Priority 1 — visible UX gaps

### ~~B5 — Frontend inline-bounds для numeric fields~~ — DONE 2026-05-15

**Status**: SHIPPED commit `deda212`. Canonical helper
`apps/frontend/src/features/inventory/lib/int-range-field-schema.ts`
mirrors server integer-range bound; surfaces per-stage RU FieldError
(«Введите число» / «Целое число» / «Не меньше N» / «Не больше N»).
Applied к ОБЕИМ formам с identical anti-pattern (per `[[no-half-measures]]`):

- `category-form-sheet.tsx` — maxOccupancy 1..20, baseBeds 1..10
- `rate-plan-form-sheet.tsx` — cancellationHours 0..720, minStay 1..30

Tests: 16 helper unit + 10 form strict (5 cat + 5 rate-plan) + 2 e2e
specs `tests/e2e/inventory.spec.ts` с axe scan. 5 layers green; ratchet
clean. Frontend unit 1644/0 (+26).

### B10 — Sidebar не highlights «Шахматка» когда на bookings drill-down

**Status**: route `_app.o.$orgSlug.bookings.$bookingId.folios.$folioId.tsx`
существует (click booking band → drill-down), но sidebar entry
`grid` с `to='/o/$orgSlug/grid' + exact:true` не matches `/bookings/X/`.
Operator на folio detail page — no menu item visible как active.

**Touched files**:

- `apps/frontend/src/components/app-shell/sidebar-sections.ts` — grid section
- `apps/frontend/src/components/app-shell/admin-sidebar.tsx` — active logic
  возможно нуждается в `activeMatch?: string` field (alternate match prefix)
  или per-section `useMatchRoute` custom predicate

## Priority 2 — admin UX completeness

### B6 — Rename / disable отдельной комнаты UI

**Status**: backend `PATCH /rooms/:id` ready. Frontend `useUpdateRoom` hook
removed по knip canon (premature export). Individual room ops:

- rename «101» → «101-A» — редкий, но real-world (когда меняют нумерацию)
- isActive toggle (room temporarily out of service for renovation)

**Touched files**:

- `apps/frontend/src/features/inventory/hooks/use-rooms.ts` — re-add hook
- `apps/frontend/src/features/inventory/components/inventory-rooms-page.tsx` —
  inline rename input или per-room edit Sheet

### B11 — Cache invalidation rooms ↔ grid (Шахматка)

**Status**: `useDeleteRoom` invalidates `roomsQueryKey(propertyId)`. Шахматка
(`/grid` route) кэширует rooms через separate queryKey. После delete
room в inventory — Шахматка показывает stale.

**Touched files**:

- `apps/frontend/src/features/inventory/hooks/use-rooms.ts` —
  `invalidateQueries` could include grid keys
- `apps/frontend/src/features/chessboard/hooks/use-grid-data.ts` —
  identify queryKey

## Priority 3 — quality gates

### Hooks renderHook coverage

**Status**: integration через page tests есть, но direct hook tests с
QueryClientProvider пишут чище coverage strokes для mutation paths
(onSuccess invalidation, optimistic updates, error handling).

Files needing hook unit tests:

- `use-rate-plans.ts` (41/47 lines/branches)
- `use-room-types.ts` (41/44)
- `use-rooms.ts` (44/30) — especially `useBulkCreateRooms` partial-failure
  fanout logic

### Mutation testing (Stryker) для inventory

**Status**: never run для feature. Memory `[[coverage_mutation_gates]]`
canon — on-demand. Inventory's pricing logic (3-mode computation +
clamp + skip) benefits from mutation testing к verify edge-case
correctness.

## Priority 4 — backend extension (require migration)

### Restrictions on rate (stop-sell / MinLOS / MaxLOS)

**Status**: backend `rate` table columns: tenantId / propertyId /
roomTypeId / ratePlanId / date / amountMicros / currency / createdAt /
updatedAt. No restriction fields. Schema extension required для closeout
/ MinLOS / MaxLOS per-day per-ratePlan.

Migration + `RateBulkUpsertInput` extension + UI affordance (Bnovo has
this в same bulk-edit modal). Backend canon needed first.

### ~~rooms-bulk-add-sheet — floor bounds~~ — DONE 2026-05-15 (B5.bis)

**Status**: SHIPPED commit `ca678a6`. Helper extended с `allowEmpty: true`
option; floor field re-wired (validator was completely unwired — schema
dead code, no FieldError; caught during self-review). +7 helper unit
[O1-O7], +6 component test [R1+B1-B5] (rooms-bulk-add-sheet.test.tsx new
file), +1 e2e spec с axe.

`startNumber` / `endNumber` cross-field refine (endNumber ≥ startNumber,
range ≤ 500, individual numbers must satisfy `roomNumberSchema` ≤20
chars) — STILL OPEN. Different shape от single-int B5/B5.bis pattern,
separate sub-phase.

## Priority 5 — gestural / power-user UX

### Drag-select range на rate grid

**Status**: per-cell click → mini-Sheet existing (Phase IV.bis). Range
drag (Hostaway 2025 mobile-friendly gesture) — optional на desktop где
click + bulk-modal закрывают gap. Mobile tap-and-hold detection +
selection highlighting required.

### Excel-style Cmd+C/V/D на grid

**Status**: research 2026-05-14 noted Linear/Airtable canon. Modal-driven
covers 100% intent для Sochi SMB scale; defer unless workflow demands.

## Empirical signals (post-B5.bis, 2026-05-15)

- Frontend suite: **1657/0** tests (was 1618 pre-B5; +26 B5; +13 B5.bis)
- Chromium e2e: **146/146** (full 2026-05-14) + 8/8 inventory.spec.ts
  (5 pre-existing + 2 B5 + 1 B5.bis) 2026-05-15
- axe WCAG 2.2 AA: **clean** across 5 inventory scans
- Coverage inventory: 66.27 lines pre-B5 (> 65 floor); +39 tests от
  B5 + B5.bis should monotonically improve when next coverage run lands
- Backend в mock-DaData mode для e2e; live mode для real-user signup
  (swap canon `[[backend-mode-e2e-swap-canon]]`)
- 3 commits ahead origin/main (`deda212` B5 + `e65e155` docs + `ca678a6`
  B5.bis); awaiting `[[batched_push]]` signal

## Resume protocol

После opening fresh session: cat `~/.claude/projects/-Users-ed-dev-sochi/
memory/MEMORY.md` first; auto-memory загрузит pointer к
`[[inventory-admin-done-2026-05-14]]` + this backlog file. Pick next
priority item only after user signal.
