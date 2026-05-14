# Inventory admin — shipping history (2026-05-14)

History record для Phase II + III + IV + bis sub-phases закрывающих gap
«нигде в админке нет управления номерами/тарифами/ценами после
онбординга» surfaced 2026-05-14.

## Phases shipped (in order)

| Commit      | Phase            | Surface                                                                      |
| ----------- | ---------------- | ---------------------------------------------------------------------------- |
| `7e83a47`   | I                | Sidebar entry «Инвентарь» (8th section, RBAC `room:update`) + 3-tab scaffold |
| `b641a5e`   | II               | «Номера и категории» — list + create category + bulk-add rooms               |
| `90fccc9`   | III              | «Тарифы» — list grouped by RoomType + create plan (7-field form)             |
| `49bfca1`   | IV               | «Цены и ограничения» — read grid + Bnovo bulk-edit Sheet                     |
| `d9a602a`\* | obs              | Backend warn DaData mock-vs-live ⏺ unrelated session-start fix               |
| `8a98482`\* | obs              | Forward-fix orgName placeholder-as-default trap ⏺ pre-inventory              |
| `3b972d2`   | II.bis + III.bis | Edit + delete для категорий и тарифов                                        |
| `062075a`   | II.bis fix       | reactive rangeSize + visible FieldError across 4 forms                       |
| `2431c38`   | II.bis.2         | dropped inventoryCount + expandable rooms + key force-remount                |
| `0c3326d`   | IV.bis           | auto-expand rooms + per-cell price edit + relative bulk ops (+%, +₽)         |
| `bdb55e9`   | chore            | drop unused RoomType import                                                  |
| `f8f1c65`   | sidebar fix      | Active state для inventory sub-tabs + cache org-list для hover-preload       |
| `9b11f43`   | bug hunt         | placeholder-as-default + negative-clamp silent + strict tests                |

(\* — observability + auth fixes related к onboarding flow обнаруженные mid-session.)

Inventory feature итого: **11 коммитов** инвентарного scope.

## Stack used (May 2026 canon)

- React 19.2.6 + TanStack Router 1.169.x + TanStack Query 5.100.10 +
  TanStack Form 1.32+ (gotcha: `useStore` для derived state per
  `[[tanstack-form-derived-state-canon]]`)
- **Radix-based vendored primitives** в `components/ui/` (не `shadcn` npm
  pkg — он dropped в commit `6ae3674` Phase 16 closure)
- Hono RPC typed client (`@horeca/backend/app` AppType)
- Zod 4 schemas в `packages/shared` (с `[[zod-coerce-boolean-gotcha]]`)
- bun:test 1.3.14 + Playwright 1.61.0-alpha-2026-05-13 +
  @axe-core/playwright 4.11.3
- Bnovo «Цены и ограничения» canonical RU UX (research 2026-05-14)

## Decisions (research-backed)

| Decision                                                            | Rationale                                                                                                                                    | Source                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **NO `react-data-grid`**                                            | SMB scale (90 rows × ≤12 cols = 1080 cells), modal-driven editing covers 100% Bnovo intent; lib adds 90 KB + APG keyboard work НЕ нужный     | research 2026-05-14 (PkgPulse 2026-03-09, Syncfusion 2026-05-13) |
| **`inventoryCount` field hidden от admin UI**                       | Decoupled-from-actual planning value (Mews/Cloudbeds/Bnovo derive count from actual rooms)                                                   | research 2026-05-14                                              |
| **3-tab IA** «Номера и категории» / «Тарифы» / «Цены и ограничения» | Bnovo update 01.05.2026 canonical RU pattern; familiar для local операторов                                                                  | Bnovo Help knowledge base                                        |
| **Edit-mode toggle на Шахматке anti-pattern**                       | Cloudbeds Capterra complaints — operator's mental model mixing                                                                               | research                                                         |
| **`<details>/<summary>` NOT used для accordions**                   | axe `nested-interactive` fail when buttons inside `<summary>` (which itself interactive); DIY `<button aria-expanded aria-controls>` pattern | Layer 5 axe catch                                                |

## Strict tests + coverage achieved

- **45 inventory test cases** (8 test files) с adversarial+immutable
  +boundary cases per `[[strict_tests]]` canon:
  - SingleRateEditSheet 7 cases ([R1-R3], [S1+S2+I1], [D1], [D2], [E1])
  - CategoryFormSheet 7 cases с immutable-field check ([S2]
    preserves existing.extraBeds + inventoryCount)
  - RatePlanFormSheet 5 cases с roomTypeId immutability ([S2])
  - BulkEditPricesSheet 6 cases — 3-mode computation [M1-M4] + validation
    [V1, V2]
  - InventoryRoomsPage / InventoryRatePlansPage / InventoryPricesPage —
    list + delete-confirm + RU plurals
- **Coverage uplift**: 59.98 → **66.27 lines** (выше 65 floor per
  `[[coverage_mutation_gates]]`)
- **Layer 4** Playwright e2e — 5 inventory specs все green
- **Layer 5** axe WCAG 2.2 AA clean (caught + fixed 3 violations в
  процессе: nested-interactive, scrollable-region-focusable,
  color-contrast on closed Dialog)
- **Full chromium regression**: 146/146 (6.1 minutes)

## Outstanding (NOT halfmeasures — explicit defer)

- **B5** frontend inline-bounds для maxOccupancy/baseBeds (Zod refine с min/max)
- **B6** `useUpdateRoom` UI (rename отдельной комнаты) — backend ready
- **B10** sidebar drill-down `/bookings/$id/folios/$id` не highlights «Шахматка»
- **B11** cache invalidation между rooms (inventory) и grid (Шахматка)
- **Hooks coverage** — `use-rate-plans` / `use-room-types` / `use-rooms`
  все 41-44 lines (ниже floor); требуют renderHook unit tests с
  QueryClientProvider
- **Mutation testing** через Stryker для inventory feature НЕ запускался
- **Drag-select range** на rate grid (Hostaway mobile pattern) — optional
- **Restrictions** (stop-sell / MinLOS / MaxLOS) — backend `rate` table
  столбцов нет, нужна migration + schema extension

См. `plans/inventory-admin-backlog.md` для priorities.

## Cross-refs (memory)

- `[[inventory-admin-done-2026-05-14]]` — main project entry
- `[[layer-4-5-mandatory-per-subphase]]` — applied here, caught 3 issues
- `[[no_halfway]]` — phase split по operator-value boundary
- `[[form_pattern_rule]]` — все create/edit forms ≤7 полей
- `[[behaviour_faithful_mock_canon]]` — backend в mock DaData mode для e2e
- `[[user_never_restarts_server]]` — Claude does backend swap dance
- `[[backend-mode-e2e-swap-canon]]` — kill+respawn mock для e2e, restore live после
- `[[tanstack-form-derived-state-canon]]` — `useStore(form.store, …)` для
  derived values (snapshot trap caught)
- `[[strict_tests]]` — exact-value + adversarial + immutable-field
- `[[coverage_mutation_gates]]` — 65/63/60/64 floor
- `[[batched_push]]` — commits accumulate locally
