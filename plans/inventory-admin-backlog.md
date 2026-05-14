# Inventory admin — backlog (status, not instructions)

Open items NOT shipped в 2026-05-14 closure. Framed как status per
`/transfer-context` skill wording rule (May 2026 canon): «X is not yet
implemented» NOT «do X next».

## Priority 1 — visible UX gaps

### B5 — Frontend inline-bounds для category form numeric fields

**Status**: HTML5 `min/max` attrs present, но Zod refine не enforces.
`maxOccupancy=0` или `21` passes client validation, fails server с 400.
Inline FieldError для bounds violation отсутствует.

**Touched files**:

- `apps/frontend/src/features/inventory/components/category-form-sheet.tsx:54-58`
- shared schemas: `packages/shared/src/roomType.ts` (server-side
  `occupancySchema = z.coerce.number().int().min(1).max(20)`)

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

## Priority 5 — gestural / power-user UX

### Drag-select range на rate grid

**Status**: per-cell click → mini-Sheet existing (Phase IV.bis). Range
drag (Hostaway 2025 mobile-friendly gesture) — optional на desktop где
click + bulk-modal закрывают gap. Mobile tap-and-hold detection +
selection highlighting required.

### Excel-style Cmd+C/V/D на grid

**Status**: research 2026-05-14 noted Linear/Airtable canon. Modal-driven
covers 100% intent для Sochi SMB scale; defer unless workflow demands.

## Empirical signals

- Frontend suite: **1618/0** tests
- Chromium e2e: **146/146** (6.1 minutes)
- axe WCAG 2.2 AA: **clean**
- Coverage inventory: **66.27 lines** (> 65 floor)
- Backend in mock-DaData mode для e2e; live mode для real-user signup
  (swap canon `[[backend-mode-e2e-swap-canon]]`)
- 22 commits ahead origin/main за inventory session

## Resume protocol

После opening fresh session: cat `~/.claude/projects/-Users-ed-dev-sochi/
memory/MEMORY.md` first; auto-memory загрузит pointer к
`[[inventory-admin-done-2026-05-14]]` + this backlog file. Pick next
priority item only after user signal.
