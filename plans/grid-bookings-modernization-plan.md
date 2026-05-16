# Plan canon — Шахматка + Bookings modernization

**Owner**: ed (Claude Opus 4.7, 1M context).
**Created**: 2026-05-15.
**Status**: G1 ✓ + G2 ✓ + G2.bis ✓ + G3 ✓ + G3.bis ✓ + G4 ✓ + G4.bis ✓ +
G5 ✓ + G6 ✓ + G6.bis ✓ + **G7 ✓ shipped 2026-05-16** (Pragmatic DnD 1.8.1
drag-move band + WCAG 2.5.7 pointer-alternative dialog «Переместить в
категорию» + 14 G7-e2e + 6 AT integration). Next: G8 (Unassigned panel +
auto-assign) — needs backend allocation service + per-sub-phase R1+R2.

History (2026-05-15 session):

- G3.bis (`f7470fb`): rename booking-{create,edit}-dialog → \*-sheet
  (plan §G3 explicit canon, deferred originally)
- G4.bis (`41be621`): закрыл e2e gap (7 new specs) + property-based
  (15 fc.property cases) + tooltip unit (8 new cases) + REAL BUG FIX
  «RUS alpha-3 → notRequired» (was 'pending' — silent МВД-pipeline
  trigger для RU citizen) + extracted shared `isRussianCitizenship`
- G6.bis (`c77fb59`): e2e gap closed (6 new cases) + sequential test-
  isolation flake fix (localStorage stub collision pre-existing)
- G5 (`a4c09ae`): Apaleo Amend-Stay — 3 PATCH endpoints (move-dates /
  change-rate-plan / change-guests-count) + atomic inventory rebalance
  - 14 real-YDB integration tests + 8 e2e + adversarial 9-item passed

Per `[[pre-plan-codebase-recon]]` §0 ДО §1; per `[[adversarial-reading-before-done]]`
all touched files read через 9-item checklist; per `[[research-protocol]]`

- `[[research-strictness-today]]` web research май 2026 ≥ today.

## §0 — Codebase state (empirical recon, не assumed)

**M5 stack locked** (`[[m5-tech-decisions]]`, `[[architecture-decisions]]`):
TanStack Router/Query/Form + React 19 + BetterAuth 1.6.x + Lingui v6 +
Vitest-browser + Playwright + APG grid canon (`[[apg-grid-canonical]]`).

**Frontend файлы (~3000 lines total)**:

| File                         | Lines | Что                                                                                                                                                                                                                           |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chessboard.tsx`             | 450   | Main grid — hand-rolled CSS Grid, aria-colspan band cells, roving tabindex per W3C APG 2026, `@container` queries, скан-padding для WCAG 2.4.11. Today-anchor highlight (Cloudbeds canon). 15-day default / 30-day month mode |
| `booking-create-dialog.tsx`  | 239   | Click-to-create. TanStack Form, idempotency-stable per dialog mount, optimistic band. Pre-fills roomTypeId + checkIn from clicked cell                                                                                        |
| `booking-edit-dialog.tsx`    | 355   | Click-on-band. Two branches: TerminalView (read-only) / ActionView (4 transitions). Inline reason form для cancel + noShow                                                                                                    |
| `use-booking-mutations.ts`   | 152   | useRatePlans + useCreateGuest + useCreateBooking. Stripe-style idempotency, optimistic band, onMutate/onError rollback с code-based RU messages                                                                               |
| `use-booking-transitions.ts` | 181   | useBooking + 4 transition mutations. Identical optimistic pattern, cross-cache invalidation (grid + single-booking)                                                                                                           |
| `booking-create.ts`          | 253   | Pure helpers: buildGuestSnapshot (МВД-shape), buildBookingCreateBody (server-mirror), nightsCount, defaultCheckOut, pluralNights (RU morphology), pickDefaultRatePlan                                                         |
| `booking-transitions.ts`     | 126   | State machine: availableTransitions, isTerminal, labelForStatus, labelForTransition, applyOptimisticStatusUpdate                                                                                                              |
| `use-grid-data.ts`           | 86    | 3 queries (properties / roomTypes / bookings) — single-property assumption hardcoded                                                                                                                                          |
| `date-range.ts`              | 59    | Pure: UTC-anchored noon parsing, addDays/diffDays/iterateDates с 365-day cap, todayIso, compareToToday                                                                                                                        |
| `booking-palette.ts`         | 62    | Token-based status palette, axe-verified ≥4.5:1 в 12 light/dark/contrast-more combos                                                                                                                                          |
| `keymap.ts`                  | 222   | APG keymap library (Arrow/Home/End/Ctrl+Home/End/PageUp/PageDown) — `nextFocusPosition` pure function                                                                                                                         |
| `layout.ts`                  | 50    | `bandPosition` — booking → colStart/colEnd/truncated с window clipping                                                                                                                                                        |
| `booking-band-tooltip.tsx`   | 110   | Popover-on-hover с status + dates label                                                                                                                                                                                       |

**Tests**: 9 spec файлов unit + `inventory.spec.ts` 8/8 e2e. Booking band
has test coverage (`booking-band-tooltip.test.tsx`, `booking-create.test.ts`,
`booking-transitions.test.ts`). Grid `chessboard.tsx` itself has integration
via e2e (`grid.spec.ts`, `grid-a11y.spec.ts`, `grid-keyboard.spec.ts`,
`bookings.spec.ts`, `bookings-edit.spec.ts`).

**Что already canon-grade** (не трогаем без причины):

- aria-colspan grid pattern (`[[apg-grid-canonical]]`)
- Roving tabindex roving + scroll-padding для focus-not-obscured WCAG 2.4.11
- Token-based status palette (axe ≥4.5:1 в 12 combos)
- Optimistic UI с onMutate/onError/onSettled + Stripe-style idempotency
- UTC-anchored date math (recent fix `7ce8a0d` killed MSK-shift artifact)
- RU morphology pluralNights helper

### §0.1 — Backend + shared schemas (empirical, post-pink correction)

Caught self-pink: первый pass §0 был только frontend. Per `[[no-half-measures]]` —
recon должен включать server-truth ДО planning. Корректирую.

**`packages/shared/src/booking.ts` (305 lines)** — confirmed:

- **`guestsCountSchema = z.coerce.number().int().min(1).max(20)`** → G-B2 server bound
  empirically verified, не «probably».
- **`bookingCreateInput.refine` checkIn < checkOut** — strict before; client mirrors.
- **`bookingChannelCodeValues`**: 9 channels (direct/walkIn/yandexTravel/ostrovok/
  travelLine/bnovo/bookingCom/expedia/airbnb). Already enum — research §1 TravelLine
  color canon should reuse this.
- **`bookingStatusValues`**: 5 states. **Missing «overdue» state** — research §1
  TravelLine canon has overdue (Red) as UI-derived computed status from
  `checkIn < today AND status=='confirmed'`. **NOT a domain state, UI-only**.
- **`Booking` row carries** `timeSlices` (per-night frozen price snapshot),
  `tourismTaxBaseMicros` / `tourismTaxMicros` (Сочи 2% computed server-side),
  `registrationStatus` (МВД lifecycle 5-state), `rklCheckResult` (3-state),
  `cancellationFee` / `noShowFee` snapshots. **All grid overlays have ground-truth
  fields ready**.

**`packages/shared/src/guest.ts` (96 lines)** — confirmed:

- **`citizenshipSchema`**: alpha-2 OR alpha-3 ISO-3166, **uppercase regex**.
  Frontend `pattern="^[A-Z]{2,3}$"` ALIGNED but decorative under `noValidate`.
- **`documentType: z.string().min(1).max(50)`** — **EXPLICITLY documented as
  free-form**: «we don't constrain to a fixed set because МВД reporting accepts
  40+ document types; the admin UI picker validates against a reference list,
  not this schema». **Corrects G-B5 — server canon is intentionally free-form,
  UI picker is right answer, not Zod enum**.
- **`guestCreateInput` has 15+ fields** (birthDate, documentSeries, documentIssuedBy,
  documentIssuedDate, registrationAddress, phone, email, visa*, migrationCard*,
  arrivalDate, stayUntil). Current `booking-create-dialog` uses only 5 (firstName,
  lastName, middleName, citizenship, documentType, documentNumber). Major
  affordance gap — operator должен через separate guest-edit UI fill rest.

**`apps/backend/src/domains/booking/booking.routes.ts` (signature)**:

- `GET    /api/v1/properties/:propertyId/bookings` (list)
- `POST   /api/v1/properties/:propertyId/bookings` (create)
- `GET    /api/v1/bookings/:id` (single)
- `PATCH  /api/v1/bookings/:id/cancel`
- `PATCH  /api/v1/bookings/:id/check-in`
- `PATCH  /api/v1/bookings/:id/check-out`
- `PATCH  /api/v1/bookings/:id/no-show`
- **NO general `PATCH /bookings/:id`** → date/rate/guest edits need backend
  extension. Confirms G-B7 requires server work, not just UI.
- **NO availability check endpoint** → G-B6 live overlap detection: либо
  client-derive from existing booking list query, OR backend addition.

**`apps/frontend/src/routes/__root.tsx`** — minimal Outlet wrapper, route context
carries `queryClient`. No grid/booking-specific concerns.

## §1 — Mission framing

Per `[[north-star-canonical]]` + `[[initial-framing]]` 7×3:

- Шахматка = **operator's primary daily tool**. Каждое утро + каждый
  check-in/out + каждое изменение брони проходят через grid.
- Booking dialog = central workflow для создания/edit/cancel — operator
  щёлкает по cell десятки раз в день.
- Production-grade + behaviour-faithful Mocks + always-on demo —
  выполняется уже (грид построен per M5 канон, optimistic infra solid).
- Сочи SMB scale: 5-50 rooms, не chains. CSS Grid 30×30 = 900 cells —
  trivial для browser, virtualization не нужна.
- 152-ФЗ compliance: focus-not-obscured satisfied, axe-clean.

**Что НЕ в scope этого плана** (separate sub-phases):

- Multi-property switcher (single-property assumption — explicit canon)
- Channel-color overlay (М10 уже доделан с Mock)
- Group/multi-room booking (deferred per `booking-create-dialog.tsx:42`)
- Folio drill-down modernization (next phase, separate plan)
- МВД миграционный учёт UI (M8.A done, separate phase)

## §2 — Adversarial reading findings (real bugs, не theatre)

Per `[[adversarial-reading-before-done]]` 9-item checklist:

### HIGH severity (silent failure / data-integrity)

**G-B1 — `useCreateGuest` silent failure**
[`use-booking-mutations.ts:66-69`](apps/frontend/src/features/bookings/hooks/use-booking-mutations.ts:66) — `onError` only `logger.warn(...)`, **NO `toast.error`**. POST /guests fails (e.g., 409 duplicate document, 400 validation) → user sees NOTHING. Sheet stays open, spinner stops. Operator clicks Submit again. Compare `useCreateBooking` which has both logger.warn AND toast.error с code-based RU messages. Asymmetric error UX.

**G-B2 — `guestsCount` HTML5-only bounds (B5 anti-pattern lives here)**
[`booking-create-dialog.tsx:188-194`](apps/frontend/src/features/bookings/components/booking-create-dialog.tsx:188) — `<TextField type="number" min={1} max={20}>` без Zod refine. Same анти-pattern что caught for inventory (`[[zero-price-data-loss-trap]]` + `[[silent-clamp-anti-pattern]]`). `buildBookingCreateBody:83` has runtime guard throwing Error, but TanStack Form swallows exceptions; user sees nothing.

**G-B3 — No rate plan picker, auto-picks first silently**
[`booking-create-dialog.tsx:70-73`](apps/frontend/src/features/bookings/components/booking-create-dialog.tsx:70) — `pickDefaultRatePlan` returns first `isDefault && isActive`. UI shows только "тариф {plan.name}" в footer label. Tenant с 3 тарифами (BAR / Невозвратный / Завтрак включён) — operator не может выбрать. Silent default selection = wrong tariff applied к bookings.

**G-B4 — No price preview / total summary**
Operator picks 3 nights × Невозвратный rate plan = X₽ total. **Currently NO indication in dialog**. Cloudbeds/Mews/Apaleo canon: live total с per-night breakdown. Operator submits «blindly», discovers wrong amount только after booking creation. Per `[[no-half-measures]]` + central daily workflow.

### MEDIUM severity (UX traps)

**G-B5 — `citizenship` pattern decorative; `documentType` needs UI picker (NOT enum)**
[`booking-create-dialog.tsx:163-174`](apps/frontend/src/features/bookings/components/booking-create-dialog.tsx:163) — citizenship has `pattern="^[A-Z]{2,3}$"` HTML5 only; form has `noValidate` → pattern decorative. Need Zod-refine mirror of server `citizenshipSchema` (alpha-2 OR alpha-3 uppercase). **Correction post-empirical recon §0.1**: `documentType` is INTENTIONALLY free-form в server schema (МВД accepts 40+ types per `guest.ts` comment). Не Zod enum, а **UI picker против reference list** = canonical. Need reference list per МВД 2026 + Select-with-search.

**G-B6 — No live overlap detection (reactive vs proactive)**
Operator clicks empty cell. Cell IS empty в grid, но real server availability может differ (booking edited by another tab, optimistic state stale). Submit → server 409 NO_INVENTORY → toast.error «На эти даты нет свободных номеров». Reactive. Cloudbeds 2026: live overlap warning during date pick.

**G-B7 — booking-edit-dialog cannot edit dates / rate plan / guest**
[`booking-edit-dialog.tsx:160-216`](apps/frontend/src/features/bookings/components/booking-edit-dialog.tsx:160) — ActionView только transition buttons (check-in / check-out / cancel / no-show). «Подвинуть бронь на день» → only path = cancel + recreate. UX-bad для daily operations.

**G-B8 — Dates raw ISO в TerminalView / labels**
[`booking-edit-dialog.tsx:131`](apps/frontend/src/features/bookings/components/booking-edit-dialog.tsx:131) — `{booking.checkIn} — {booking.checkOut}` shows `2026-06-15 — 2026-06-18`. Compare `formatTransitionDate:344` which formats к RU. Inconsistent.

**G-B9 — `formatTransitionDate` fallback к raw ISO on NaN**
[`booking-edit-dialog.tsx:347`](apps/frontend/src/features/bookings/components/booking-edit-dialog.tsx:347) — if invalid date → returns raw ISO. User sees `2026-06-15T03:45:00.000Z` — UX-bad.

### LOW severity

- Past-date check-in not gated (G-B10): operator can input checkIn в прошлом
- Mobile keyboard pushes dialog content out of view (G-B11)
- Group/multi-room booking deferred per architecture decision (G-B12)
- Idempotency-key only stable within single dialog mount, not across reopens (G-B13 — by design but comment misleading)

## §3 — Research synthesis (май 2026, agent landed)

Research-agent landed (`a5b599a5f959ea888`). Coverage caveat: Cloudbeds Spring
Release **event 2026-05-19 (4 days post-today)**, но published material
доступен 2026-05-15 (webinar page, hoteltechnologynews.com Feb 2026 Climber-RMS
piece). Mews/Apaleo help-center gated behind 401/403; fallback к mid-2025 docs
с explicit `[≤2025]` markers. Cloudbeds + Bnovo + TravelLine — strongest 2026
canon available.

### §3.1 — Grid (Шахматка) canon per leader

| Leader                                    | Date pattern                                                                                            | Row org                                           | Band gesture                                                                                       | Mobile                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Mews** [≤2025]                          | Single horizontal Timeline, today-anchor button. Side-panel detail (NOT modal) — preserves grid context | By Space (room) с category grouping (collapsible) | Drag-move ✓; **drag-resize ✗** (documented user complaint — opportunity)                           | Operator app list-first, not grid                                                                                                        |
| **Cloudbeds** [2026-05]                   | **4d/1w/2w/3w/fit-to-screen** display range; mini-calendar picker; sticky «back to today» first-class   | By room (Accommodation) grouped by type           | Drag-and-drop reservation between rooms; **Unassigned Reservations panel** top-left + auto-assign  | List/grid hybrid, arrival/departure checklist                                                                                            |
| **Apaleo** [≤2025]                        | List-first + Reservation Diary. Booking ≠ Reservation (1 booking = N stays)                             | By room в diary                                   | Drag в diary                                                                                       | Single-stay drill-down on dedicated route — **«Amend Stay» canon** covers extend/reschedule/switch-roomtype/adjust-pax all on ONE screen |
| **Hostaway** [2026]                       | Multi-Calendar (vacation-rental)                                                                        | Properties → **expandable sub-rows**              | Mobile = dropdown for room move; **drag explicitly disabled на touch** (Hostaway product decision) | Mobile-first canon                                                                                                                       |
| **Bnovo** [release 2024-09, current 2026] | **Adaptive — 15/30/fit** auto-fits months к screen                                                      | By room, grouped by category                      | Overbooking red highlight; arrival/departure highlight + nights count on band                      | Native iOS/Android parity. **Offline mode** 36 days local cache (2 back + 34 forward) — relevant к Сочи infra                            |
| **TravelLine** [color canon 2026]         | Standard tabular                                                                                        | Rooms grouped by category                         | Click intersection → create                                                                        | Limited subset; tap creates; blue indicator for unassigned-count                                                                         |

### §3.2 — TravelLine 8-color canon (RU staff already trained на это)

| Status                   | Color          | Meaning                                                    |
| ------------------------ | -------------- | ---------------------------------------------------------- |
| Direct + manual          | **Green**      | Booking engine + walk-in                                   |
| OTA via CM               | **Yellow**     | yandexTravel/ostrovok/etc                                  |
| Checked-in (in-house)    | **Purple**     | Currently staying                                          |
| Checked-out              | **Orange**     | Stay complete                                              |
| **Overdue** (UI-derived) | **Red**        | `checkIn < today AND status='confirmed'` — action required |
| **Unassigned**           | **Turquoise**  | Нет assignedRoomId                                         |
| **OOO / Maintenance**    | **Grey**       | Block-cell affordance                                      |
| Filter-deactivated       | **Light grey** | Tag filtered out                                           |

Current `booking-palette.ts` covers 5 base states (confirmed/in_house/checked_out/
cancelled/no_show). Missing: overdue (UI-computed), unassigned (UI-computed),
OOO (need backend extension OR separate domain). TravelLine yellow для
non-walkIn/non-direct channels — surface from `booking.channelCode`.

### §3.3 — Booking dialog canon

**Apaleo single-stay drill-down (still 2026)** — Amend Stay covers extend /
reschedule / switch room-type / adjust adults+children / set custom arrival-
departure-time — all in **ONE screen** on a dedicated URL. **Apaleo canon =
the 2026 reference для booking edit affordance**.

**Mews + Cloudbeds canon** — booking detail = **right-side panel**, NEVER
modal. Preserves grid context. Our `Dialog` modal pattern conflicts; need
shift к `ResponsiveSheet side="right"`.

**Field order canon**: dates → room-type → rate-plan → guest → payment.
Reasoning: rate plans depend on dates. Current dialog has guest FIRST → date
LAST. **Should reverse** per leaders 2026.

### §3.4 — Technical stack picks (research-recommended)

| Concern        | Pick                                                                                                                                  | Why                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Virtualization | TanStack Virtual 3.13+ (4.x beta)                                                                                                     | Same author ecosystem as TanStack Router/Query/Form. APG-compliant (we own DOM). 30×30=900 cells current — **virtualization deferred until chain customers с 100+ rooms** |
| Drag library   | **`@atlaskit/pragmatic-drag-and-drop` 1.7.x**                                                                                         | dnd-kit maintainer status precarious (issue #1194 open); Pragmatic = Trello/Jira production-proven, native browser drag APIs, framework-agnostic, mobile-friendly         |
| Date           | **`date-fns 4` + `date-fns-tz`** + `Temporal` polyfill behind feature-detect                                                          | March 2026 PkgPulse guide: date-fns won TanStack ecosystem. Temporal Stage 4 March 2026, native в Chrome 144+/Firefox 139+. Shim out when shipped                         |
| Form           | TanStack Form v1 (already canon)                                                                                                      | Per `[[feedback_tanstack_form_derived_state_canon]]` — `useStore(form.store)` для reactive reads                                                                          |
| Real-time      | **SSE (Server-Sent Events)** — backend CDC → SSE → React Query invalidate                                                             | 2026 canon для one-way push. WebSocket overkill. Hotel grid is strictly one-way (clerk A's mutation → others see). NO multiplayer cursors needed                          |
| a11y           | React Aria primitives (`useCalendar`/`useRangeCalendar`/`useGridList`) **только как building blocks**. NOT full React Aria Components | Too opinionated, breaks aria-colspan + grid-column span canon                                                                                                             |

### §3.5 — RU/Сочи compliance overlays

- **ПН (Monday) anchor canon**: Cloudbeds ships «Choose Your Calendar Start Day»
  setting Spring 2026; `date-fns weekStartsOn: 1` per Lingui ru override.
  Current grid: `formatDateHeader` uses Russian short weekday (пн/вт/...) — OK
  for header rendering, но week-anchor canon needs explicit audit.
- **152-ФЗ PII в band**: Show first-name + last-initial по default; full name
  только в detail drawer. Bnovo/TravelLine surface full name (RU canon),
  acceptable for staff-only, но screen-share-mode toggle нужен. Audit-log
  band-hover that reveals PII.
- **Туристический налог chip**: 2% Сочи + min ₽100/night per НК РФ ch.33.1
  (replaces repealed курортный сбор). Quarterly reporting 27.04/27.07/26.10/25.01.
  **Backend already computes `tourismTaxMicros` per booking** — surface на band
  via small ₽ chip («ТН 120₽»). Льгота flag для Сочи-residents.
- **МВД миграционный учёт badge**: Госпошлина 500₽ since 2025-09-01. Status badge
  «МУ не подан / Подан / Просрочен» from `booking.registrationStatus`.
  **Backend already tracks 5-state lifecycle** — direct UI surface.
- **Channel-color via `booking.channelCode`**: yandexTravel = yellow (TravelLine
  canon) OR red-orange dot для differentiation. Already enum в schema.

### §3.6 — Anti-patterns confirmed (research-backed)

1. **Modal dialog для booking-create на desktop** — Mews/Apaleo canon =
   side-panel preserves context. Current `<Dialog>` violates this.
2. **AG-Grid / react-data-grid для Шахматки** — fights APG canon, inflates
   bundle. Already correctly avoided.
3. **`react-beautiful-dnd`** — deprecated, React 19 compat uncertain.
4. **`@hello-pangea/dnd`** — list-only, no grid support.
5. **Mobile drag-and-drop для reservations** — Hostaway product team explicitly
   chose dropdown. Touch precision insufficient for date bands.
6. **Mews-style «extend stay forces multi-click separate page»** — documented
   user complaint. Ship drag-resize from day 1.
7. **Sunday-anchored week (JS default)** — must override globally `weekStartsOn: 1`.
8. **Storing local-time в YDB** — UTC server, MSK presentation. Current
   `date-range.ts` already canon (UTC-anchored noon parsing).
9. **Tourism tax hardcoded 2%** — varies by region (Москва 1%, Сочи 2%, others
   differ). Read from tenant config, **not** literal в code.
10. **Inline guest creation без dedup** — Bnovo lets duplicate guests; 152-ФЗ
    minimization → fuzzy-match by phone/email before creating new.
11. **No «back to today» anchor** — Cloudbeds Spring-2026 first-class affordance.
    **We already have it** [`chessboard.tsx:231-238`](apps/frontend/src/features/chessboard/components/chessboard.tsx:231) — kept as canon ✓.

## §4 — Phased plan (research-synthesized, revision 2)

Merged §2 bug findings + §3 research recommendations. Pre-empts «patch then
rebuild» trap by sequencing foundation → architectural → feature.

### ~~Phase G1 — HIGH bug fixes~~ — DONE 2026-05-15

**Shipped** в commit `d18d747` (G1) + backend root-cause `5b38c26`:
• G-B1: `useCreateGuest` toast.error on failure (symmetric с useCreateBooking)
• G-B2: guestsCount validator via `intRangeNumberValidator({min:1, max:20})`
• G-B3: rate plan picker `<Select>` of active plans, default seeded via useEffect
• G-B4: live price preview component с rate-grid query, RU currency format
• Helper moved `features/inventory/lib/` → `lib/forms/` (3rd consumer arrived)
• Helper extended с `intRangeNumberValidator` для number-typed fields

**Pre-existing root cause caught** (separate atomic commit `5b38c26`):
• Onboarding service seeded property+roomType+rooms+ratePlan+rate × 90
но NOT availability rows. Booking creation hit `NO_INVENTORY` для каждого
night. Pre-Phase-16 closure (`8436dd7` per-worker tenant) масked by
shared demo tenant. Per-worker isolation exposed gap.
• Fix: step 6 в onboarding tx — availability × 90 with `allotment=rooms`
• Test [I8] strict 1:1 date alignment + no orphan rate без availability
• Overbooking e2e test repaired: pre-fixture sets `allotment=1` via admin
`POST /room-types/:id/availability` (canon: test uses ops endpoint)

**Empirical (verified pre-commit)**:
• frontend unit: 1685/0 (was 1671 → +14 number-validator)
• property-based: 6 × 964 expect calls
• e2e chromium: 14/14 (bookings 7/7 incl. 3 new G1 + inventory 8/8)
• axe WCAG 2.2 AA: clean
• coverage int-range-field-schema.ts: 100/100
• ratchet OK: all metrics 0

**Memory canons recorded** (`[[memory-is-canon-not-backlog]]`):
• `[[baseline-e2e-before-coding]]` — meta-lesson from G1 ship
• `[[backend-recon-end-to-end]]` — plan §0 must trace pipeline, не just sigs
• `[[no-preexisting-excuse]]` reinforced via root-cause fix vs «skip»

### Backlog (caught during G1 self-review, не shipped)

**Idempotency-stuck-on-retry trap** (`booking-create-dialog.tsx`):
Idempotency key generated per-dialog-mount via `useMemo([])`. If first
POST /bookings fails (e.g., 409 NO_INVENTORY), key persists. User
edits date + retries → server idempotency replay returns SAME 409.
Stuck unless they close + reopen dialog. Stripe canon: idempotency
key replays same operation, не «retry with new state». Need
regenerate-on-failure OR new key when user edits dates. **Pre-existing,
не G1 regression**. Note as G3 candidate (rolling into edit affordance).

**roomType.inventoryCount ↔ availability.allotment drift** (post-B5 +
G1 backend fix): operator can edit `roomType.inventoryCount` via admin
UI (B5 done) but availability.allotment is seeded at onboarding и
stays. Edit `inventoryCount: 10 → 5` doesn't reduce allotment к 5.
Bookings can still take all 10. Data integrity bug. Need either:
(a) PATCH /room-types/:id cascade-updates future availability rows,
(b) availability читает allotment from roomType.inventoryCount in
realtime. Future phase decision. **Pre-existing, не G1 regression**.

**Component test coverage gap для booking-create-dialog**:
86.67/82.16 post-self-review (added 7 strict tests). Uncovered: error
paths (createBooking rejection toast), price preview loading state,
Subscribe edge-cases. NOT critical для floor (above 65), но useful
delta для G2+ work.

### Phase G1 implementation history (для reference)

**Empirical bound source**: server `guestsCountSchema.min(1).max(20)` (booking.ts:122);
server idempotency replay canon (booking.routes.ts).

**Scope** (4 HIGH bugs from §2):

- **G-B1 fix**: `useCreateGuest` onError → add `toast.error(extractRuMessage(err))`.
  Same pattern as `useCreateBooking` (asymmetric error UX → symmetric).
- **G-B2 fix**: `guestsCount` → `intRangeFieldSchema({min: 1, max: 20})` через
  TanStack Form validator + inline FieldError. Mirrors `[[zero-price-data-loss-trap]]`
  canon — server bound mirrored client-side.
- **G-B3 fix**: rate plan picker → `<Select>` of `ratePlansQ.data.filter(isActive)`,
  default = `pickDefaultRatePlan`. `form.Field name="ratePlanId"`.
- **G-B4 fix**: live price preview. Source = ratePlan's base price (initial), then
  refined в G5 к rate-grid lookup. Шоу «nights × rate = total» в footer
  через `form.Subscribe`.

**Layer 4+5**: e2e `tests/e2e/bookings.spec.ts` extend: guestsCount=0/21 + ratePlan
picker + price preview rendering + guest-create-failure toast visible.

**Strict tests**: exact-value messages, immutable-field (rate switch не сбрасывает
dates), adversarial (guest 409 → toast surfaces).

**Complexity**: LOW. 1 commit, ~150 LoC.

### ~~Phase G2 — Status palette extension к TravelLine 8-color canon~~ — DONE 2026-05-15

**Shipped** в commit `6598116`:
• `paletteFor(ctx)` derived helper с 5-step precedence canon (terminal
→ overdue → unassigned → confirmed → in_house)
• `DERIVED_BOOKING_CELL_STYLES` export {overdue, unassigned}
• `--status-unassigned` CSS token (light/dark/contrast-more variants
verified ≥4.5:1 paired с \*-foreground)
• GridBooking shape extended с `assignedRoomId?: string | null` (server
already serves; was narrowed-out)
• chessboard.tsx threads `paletteFor({booking, todayIso})` instead of
`styleFor(status)`

**Coverage**: booking-palette.ts **100/100** funcs/lines. 14 new strict
cases [P1-P5, A4, I1-I2] + no-hardcoded-palette × 2.

**Empirical**: e2e 37/38 (1 pre-existing booking-EDIT axe flake, not G2);
unit 1712/0; ratchet clean.

**G2.bis SHIPPED 2026-05-15** в commit `a3c5ffe` (closed user pinok
«ты снова все забыл»):
• `channelIndicator(channelCode)` 9-enum exhaustive (direct/walkIn → null;
yandexTravel red-orange; 6 OTA → yellow per TravelLine canon)
• CSS tokens `--channel-yandex` / `--channel-ota` (light/dark, ≥3:1
non-text contrast)
• GridBooking + `channelCode?: BookingChannelCode`
• chessboard 6px dot top-right + aria-label expansion
• BookingBandTooltip channelLabel row
• Demo seed variety: +2 overdue + 6 mixed channelCodes (always-on demo
canon: new customers see G2 + G2.bis visually)
• Tests +28 strict
• Memory canon recorded: `[[halfmeasure-in-initial-scope]]`

**Deferred к G9 (out-of-G2 scope)**: OOO maintenance bands (grey
TravelLine canon) — requires backend `propertyBlock` domain extension.

### Phase G2 implementation history (kept для reference)

**Empirical bound source**: §3.2 TravelLine canon; current `booking-palette.ts` 5 base
states; `booking.channelCode` enum already в schema.

**Scope**:

- Extend `BOOKING_CELL_STYLES` с 3 UI-derived states: **overdue** (Red,
  `checkIn < today && status='confirmed'`), **unassigned** (Turquoise,
  `assignedRoomId === null && status='confirmed'`), **OOO** (Grey,
  separate domain — defer until backend has block-cell, **note as G2.deferred**).
- Add `paletteFor(booking, today)` helper — combines status + channelCode +
  derived states. Per TravelLine: non-direct/non-walkIn channels → Yellow
  outline или dot. yandexTravel separate red-orange dot per `[[differentiator]]`.
- Token-based палитра extension в `index.css` `--status-*`. Verify axe
  ≥4.5:1 across 12 light/dark/contrast-more combos (current canon).

**Complexity**: LOW. 1 commit, ~80 LoC + token CSS.

### Phase G3 ✓ + G3.bis ✓ DONE 2026-05-15 — Dialog → ResponsiveSheet right-side panel architectural shift

**Empirical bound source**: §3.3 Mews/Cloudbeds canon = side-panel preserves grid
context; existing `<ResponsiveSheet>` infra used в inventory forms.

**Shipped** (commit `8a27892`, single atomic per `[[no-half-measures]]`):

- ✅ `<Dialog>` → `<ResponsiveSheet side="right">` в both
  `booking-create-dialog.tsx` + `booking-edit-dialog.tsx`. **Component
  file-names kept** (`BookingCreateDialog` / `BookingEditDialog`) для
  zero-churn import-sites; `getByRole('dialog')` Playwright canon preserved
  (Sheet exposes the role natively).
- ✅ Field order create form (per Mews/Cloudbeds canon): **dates first →
  rate-plan → guest fields**. Operator scans availability + price BEFORE
  entering PII.
- ✅ Mobile branch: `<ResponsiveSheet>` auto-switches к bottom Drawer (Base UI
  Drawer 1.4.1 GA, Vaul-unmaintained migration already done в A.bis.0).
- ✅ Grid stays visible during create + edit — operator sees adjacent dates
  through right-side panel.

**Layer 4+5 verified**:

- ✅ e2e regression fallout: `[data-slot="dialog-footer"]` →
  `[data-slot="sheet-footer"]` в `bookings-edit.spec.ts:150`;
  `[aria-label="Закрыть"]` icon-button absent on Sheet (shadcn canon uses
  English `sr-only "Close"`) → tests pivot к `getByRole('button',
{ name: 'Закрыть' })` footer button in `grid-keyboard.spec.ts:303`.
  Bug-hunt byproduct: stale `admin-sidebar.spec.ts toHaveCount(7)` surfaced
  (canon = 8 per `sidebar-sections.test.ts:57`) — fixed.
- ✅ axe WCAG 2.2 AA: covered by existing axe specs (no new violations).
- ✅ Unit: frontend 1740/0.
- ✅ Ratchet: depcruise=0 knip=0 audit_high=0 ts_err=0 biome_err=0
  weak_assertions=0 multi_biome_ignore=0.

**Pre-existing flake noted (NOT G3 regression)**:
`admin-multi-tab-broadcast.spec.ts:31` — tab B doesn't redirect к /login on
tab A logout broadcast. Stash-bisect confirmed pre-existing на origin/main;
unrelated к G3 architectural shift. Backlog item, separate session.

**Outcome**: 52 booking-surface chromium specs green; modal-overlay
anti-pattern killed; grid-context-preserving canon established.

### Phase G4 ✓ + G4.bis ✓ DONE 2026-05-15 — RU compliance overlays (152-ФЗ + ТН + МВД)

**Empirical bound source**: §0.1 backend already computes `tourismTaxMicros` +
`registrationStatus`; §3.5 RU canon.

**Shipped** (commit `ca1303c`, single atomic per `[[no-half-measures]]`):

- ✅ **152-ФЗ default mask** (PRIMARY canon shift): band visible label
  changed status → `maskGuestNameRu(snapshot)` («Фамилия И.»). Mews /
  Cloudbeds / Apaleo industry canon — guest IS the band identifier; status
  conveyed via colour + aria-label (semantic preserved). Tooltip on
  intentional hover REVEALS full name (operator action).
- ✅ **Туристический налог chip**: `formatTourismTaxRub(micros)` helper
  pure-fn, half-up rounding, ГОСТ 8.417 NBSP separator. Shown в tooltip
  («Туристический налог: 120 ₽»). Skip on cancelled. Returns null on zero
  (Cloudbeds no-zero-clutter canon).
- ✅ **МВД status badge**: `registrationBadgeFor(status, citizenship)` —
  top-left 4px dot, only foreign guests (RU/RUS → null), 5-state enum
  exhaustive. Color-coded: status-issue red for pending/failed (urgent),
  status-confirmed green for submitted, status-occupied blue for
  registered. Reuses axe-verified status-\* tokens.
- ✅ aria-label extended: status + channel + МВД + tax. Full screen-reader
  parity с visual chips.
- ✅ data-mvd-status + data-mvd-urgent attrs для e2e probing.

**Backend changes**: **ZERO**. `listByProperty` already serializes
guestSnapshot + registrationStatus + tourismTaxMicros на every Booking row;
GridBooking narrow type extended to thread through.

**ПН-anchor**: deferred. `formatDateHeader` weekday array already correct
(['вс','пн','вт','ср','чт','пт','сб'] indexed by getUTCDay 0=Sunday).
Grid windowFrom не enforces week-alignment by design (operator-driven
navigation), so no UX gap. Re-evaluate if G6 display-range selector
includes «week» preset.

**Layer 4+5 verified**:

- ✅ Frontend unit: 1764/0 (+24 new G4 strict cases: maskGuestNameRu × 8 inc.
  empty-firstName fallback + immutability + Latin lastName; formatTourismTaxRub
  × 7 inc. half-up rounding + ГОСТ NBSP guard; registrationBadgeFor × 8 inc.
  RU citizenship null + enum-exhaustive + urgent-flag aligns с red dot)
- ✅ Bookings-surface chromium e2e: 44/44 (5 stale `band.toContainText(status)`
  migrated к `band.toHaveAttribute('aria-label', /status/)`; new assertion
  catches full-name leak regression: `band.toContainText('Edit11 Т.')`)
- ✅ Full chromium e2e: 175/176 (1 pre-existing multi-tab-broadcast flake
  unrelated к G4)
- ✅ axe WCAG 2.2 AA: clean (status-\* tokens reused — already verified)
- ✅ Ratchet: depcruise=0 knip=0 audit_high=0 ts_err=0 biome_err=0
  weak_assertions=0 multi_biome_ignore=0

**Pure helpers added к `booking-palette.ts`**: 152 LoC.

### Phase G5 ✓ DONE 2026-05-15 — Booking edit affordance (Apaleo single-stay canon)

**Empirical bound source**: §0.1 backend exposes ONLY transition PATCH endpoints,
NO general PATCH; §3.3 Apaleo canon = single-stay drill-down.

**Shipped** (commit `a4c09ae`, atomic single-commit per `[[no-half-measures]]`):

- ✅ **Backend** — 3 separate PATCH endpoints per service-method canon
  (mirror cancel/check-in/check-out separation):
  - `PATCH /bookings/:id/move-dates` — atomic inventory rebalance:
    release sold-1 для (old\new) nights, reserve sold+1 для (new\old) с
    stopSell + allotment guards. Recomputes timeSlices, totalMicros,
    cancellationFee.dueDate, noShowFee, tourismTax.
  - `PATCH /bookings/:id/change-rate-plan` — validates new plan belongs
    к same (propertyId, roomTypeId); idempotent no-op same plan returns
    current; recomputes price snapshots. No inventory mutation.
  - `PATCH /bookings/:id/change-guests-count` — schema-bounded (1..20)
    UPSERT of guestsCount only. No inventory / price recompute. Allowed
    on `in_house` ALSO per Apaleo walk-up companion canon.
- ✅ **Status policy** (new error `InvalidBookingAmendStateError` → 409):
  - move-dates / change-rate-plan: confirmed-only
  - change-guests-count: confirmed OR in_house
  - terminal (cancelled/checked_out/no_show) → 409 для all 3
- ✅ **Shared schemas** (`packages/shared/src/booking.ts`): 3 input types
  с canonical strict validation (date refine, ID format, 1..20 bounds).
- ✅ **Repo helper** `upsertAmendedBookingRow` — UPSERT-merge с amend-field
  overrides parallel к existing transition `upsertBookingRow`. Distinct
  type AmendOverride keeps mutability separated semantically.
- ✅ **Frontend** — 3 mutation hooks (`useMoveDatesBooking`,
  `useChangeRatePlanBooking`, `useChangeGuestsCountBooking`) с invalidate-
  on-settled (NO optimistic — amend touches many fields). Canonical RU
  error messages для 409 INVALID_BOOKING_AMEND_STATE / 409 NO_INVENTORY / 404. ActionView extended с 3 inline editor forms + new «Изменить бронь»
  section appearing когда status is confirmed (3 buttons) OR in_house
  (only change-guests-count, per Apaleo canon).

**Deferred** (separate scope, low priority):

- `formatTransitionDate` fallback «недействительная дата» (G-B9) —
  trivial follow-up, не blocking.
- TerminalView dates formatted RU via formatTransitionDate canon — UX
  polish, не affordance gap.

**Layer 4+5 verified**:

- ✅ Backend integration: **14/14** real-YDB tests covering inventory
  rebalance via direct SQL verification + cancellationFee.dueDate shift +
  cross-tenant 404 + status guards + idempotent no-op + cross-property
  RatePlanNotFoundError + in_house allowed for guests-count + null on
  non-existent id.
- ✅ Frontend unit: 1795/0 (no regression).
- ✅ Booking-surface chromium e2e: **63/63** (canonical order: bookings →
  bookings-edit → g4-bookings-compliance → g5-bookings-amend-stay → grid
  → grid-a11y → grid-keyboard). New G5 spec covers happy path × 3 +
  validation × 2 + terminal-hidden + cross-tenant 404 × 3 routes.
- ✅ Adversarial 9-item checklist passed (zero-permit / silent-clamp /
  reversed-input / hidden-state / server-cap / NaN-slip / race / reset
  semantics / closure-stale — see commit body).
- ✅ Ratchet: depcruise=0 knip=0 audit_high=0 ts_err=0 biome_err=0
  weak_assertions=0 multi_biome_ignore=0.

**Complexity actual**: MED-HIGH. Single atomic commit ~1900 LoC.

### Phase G6 ✓ + G6.bis ✓ DONE 2026-05-15 — Display range selector (Cloudbeds Spring 2026 canon)

**Empirical bound source**: §3.1 Cloudbeds 4d/1w/2w/3w + fit-to-screen;
current `ChessboardWindowSelector` has 15/30/fit.

**Shipped** (commit `868983a`, single atomic per `[[no-half-measures]]`):

- ✅ ChessboardWindowSelector extended: 8 options total (3d/4d/1w/2w/15d/
  3w/30d/fit). WindowDays type additive: `3 | 4 | 7 | 14 | 15 | 21 | 30 |
'fit'`. Previously-persisted Zustand `15` remains valid — no migration.
- ✅ RU labels follow ГОСТ morphology: «1 неделя» (singular nominative)
  / «2 недели» (plural genitive) / «3 недели» (plural genitive). Cloudbeds
  w1/w2/w3 aliases mapped к 7/14/21 day values.

**Deferred / non-scope**:

- Mini-calendar date-picker on header: existing `ChessboardDatePicker`
  already mini-calendar. No scope.
- Keyboard `[`/`]` week-step: existing «← Назад / → Вперёд» buttons
  step by `windowDays`, so when window=7 они step by 1 week
  natively — already Cloudbeds canon. No additional binding needed.

**Layer 4+5 verified**:

- ✅ Frontend unit: 1772/0 (+10 new G6 strict cases inc. backward-compat
  legacy-15-still-works + 8-option dropdown exact order + week-alias
  store round-trip)
- ✅ Bookings+grid chromium e2e: 44/44 (canonical test order)
- ✅ Ratchet: green

**Complexity actual**: LOW. 1 atomic commit ~107 LoC.

### Phase G7 ✓ DONE 2026-05-16 — Drag-move band gesture (Pragmatic DnD)

**Pre-impl research 2026-05-16** (per `[[research-strictness-today]]` +
`[[research-protocol]]` 2026 only + HoReCa leaders + `[[gh-api-ground-truth]]`
empirical npm view): scope CORRECTED ↓.

**Empirical bound source**: §3.4 Pragmatic DnD canon (verified 2026-05-16:
**1.8.1** latest stable, NOT 1.7.x); §3.6 Hostaway mobile-disable canon
(verified 2026-05-16 still current). Mews/Cloudbeds/Bnovo canon: WHOLE-band
drag (not grip-handle). Apaleo amend-stay = form-based, NOT drag-resize.

**Concrete D-decisions (R1+R2 ≥ 2026-05-16 fresh)**:

- **D-G7.1** `@atlaskit/pragmatic-drag-and-drop@1.8.1` (NOT 1.7.x как план
  написал — устарело за день). Sub-packages: `*-react-drop-indicator@3.2.15`
  - `*-react-accessibility@2.2.9`. Все React 19 compat verified via
    `npm view ... peerDependencies`.
- **D-G7.2** Gesture: **whole-band drag** (Mews/Cloudbeds/Bnovo consensus).
  NO grip handle. Locked blocks (in_house / cancelled / checked_out / no_show)
  opt-out via `canDrag: () => false`.
- **D-G7.3** Visual: pragmatic native drag preview + `react-drop-indicator`
  drop-zone outline. Popover API path (1.8.0+) default; Safari 17 / Chrome
  114 baseline acceptable per browserlist.
- **D-G7.4** Conflict resolution: pre-detect overlap on `onDrag` (not
  `onDrop`); highlight target row red; reject drop. Mews upgrade-only
  invariant DEFERRED (no category-upgrade UX в M0).
- **D-G7.5** Mobile policy: drag DISABLED on `@media (pointer: coarse)` +
  `matchMedia` runtime guard. Mobile users use ActionView amend dialog
  (same canon как Hostaway 2026 + satisfies WCAG 2.2 SC 2.5.7).
- **D-G7.6** **WCAG 2.2 SC 2.5.7 (mandatory AA)**: ALL drag functionality
  MUST have single-pointer non-drag alternative. **Implementation**:
  ActionView `booking-edit-sheet.tsx` получает NEW «Переместить в категорию»
  amend button + roomType dropdown form. Это pointer alternative + keyboard
  - mobile fallback ONE shape. Reuses G5 amend canon.
- **D-G7.7** Keyboard: focus band → Enter opens ActionView (already
  existing canon) → operator picks new roomType. NO custom drag-mode
  keyboard handler — would conflict с roving tabindex grid model. Per
  `[[no-half-measures]]` reuse existing affordance не invent.
- **D-G7.8** Drag-resize edges + drag-create: **DEFERRED**. Apaleo canon
  doesn't use drag-resize (form-based amend); Mews/Cloudbeds vague на
  resize gesture. Drag-create — no leader 2026 canon found. Wait для user
  signal before adding.
- **D-G7.9** Playwright e2e suite: drag-happy (desktop), drag-conflict-
  reject, drag-locked-block-disabled, mobile-pointer-coarse-disabled, ALL
  affordances ALSO via ActionView dialog (pointer alternative), keyboard
  Enter→dialog→change, cross-tenant 404. Plus axe scan на drag-mode entry.
- **D-G7.10** Watch GitHub issues (verified open 2026-05-16): #234
  (`dropTargets` empty в location.current edge), #229 (horizontal scroll
  jitter — RELEVANT — наша Шахматка имеет horizontal date scroll). Add
  regression e2e if reproducible.

**Backend new endpoint** (mirrors G5 amend canon):

- `PATCH /bookings/:id/change-room-type` — body `{ roomTypeId }`. Service
  validates new roomType belongs к same property; verifies rates exist для
  booking dates на new roomType; atomic inventory swap (release old
  roomType nights × sold-1, reserve new roomType nights × sold+1 с
  stopSell + allotment guards); recompute timeSlices + fees + tax.
- New `bookingChangeRoomTypeInput` schema + `InvalidBookingAmendStateError`
  reuse + `RoomTypeNotFoundError` reuse.
- Status guard: confirmed-only (matches change-rate-plan canon).

**Complexity actual**: MED-HIGH. Single atomic commit ~2000 LoC matching
estimate. Backend ~600 (route + service + repo с upsertAmendedBookingRow
extension + AmendOverride с roomTypeId/ratePlanId/assignedRoomId) +
frontend hooks ~120 (useChangeRoomTypeBooking + useGridDragMoveRoomType +
useRoomTypes) + ActionView extend ~80 + chessboard.tsx DnD wiring +
CSS visual feedback ~150 + integration tests ~250 (6 AT-cases) + e2e
~410 (14 G7-cases).

**Layer 4+5 verified**:

- ✅ Backend integration: 20/20 real-YDB (14 G5 + 6 G7 AT1-AT6: happy
  path / inventory swap via direct SQL / idempotent no-op / cross-property
  RoomTypeNotFoundError / cancelled-status guard / cross-tenant null)
- ✅ Frontend chromium e2e: 14/14 G7 (dialog button visible / hidden для
  terminal / happy path / no-op submit-disabled / cross-tenant 404 /
  status-guard 409 / idempotent 200 / data-row-room-type-id wire /
  locked-block opt-out / **keyboard alternative** / **mobile pointer-coarse
  gate** / **axe WCAG 2.2 AA after dialog open** / **Pragmatic dragTo
  empirical drag-gesture E13**)
- ✅ Full booking-surface regression: 73/73 (bookings + bookings-edit +
  g4-compliance + g5-amend-stay + **g7-room-type-move** + grid +
  grid-a11y + grid-keyboard)
- ✅ Frontend unit: 1795/0 (no regression)
- ✅ Adversarial 9-item passed; surfaced defensive `assignedRoomId: null`
  clear на roomType swap (prevents stale pointer к specific room в old
  roomType when feature evolves к allow assignedRoomId on confirmed).
- ✅ Memory canons recorded: `[[pragmatic-dnd-1.8.1-canon]]` +
  `[[id-prefixes-check-before-test]]`.
- ✅ Ratchet green.

**Empirical surprise**: Playwright `dragTo` DOES trigger Pragmatic DnD
HTML5 drag events reliably в headless Chromium — research-agent была
осторожна «may be inconsistent» but empirical E13 test passed. Per
`[[empirical-before-asserting-limits]]` always TRY first.

### Phase G8 — Unassigned Reservations panel + auto-assign

**Empirical bound source**: §3.1 Cloudbeds Spring 2026 panel; §0.1 booking has
`assignedRoomId` nullable.

**Scope**:

- Top-left panel «Нераспределённые» с orange-dot count of bookings
  с `assignedRoomId === null && status='confirmed'`.
- Click panel → list view → click booking → assign room flow (separate
  room selector dialog OR drag from panel к row).
- «Авто-назначение» button → backend service to mass-assign per allocation
  rules.

**Complexity**: MED-HIGH. Backend allocation service. 2-3 commits.

### Phase G9 — Live overlap detection + block-cell (OOO maintenance)

**Empirical bound source**: §3.1 Bnovo overbooking red highlight; no current
availability endpoint per §0.1.

**Scope**:

- **Live overlap check**: while filling create-sheet, re-query bookings list
  for selected dates + roomType. Show conflict banner inline.
- **OOO band**: separate `propertyBlock` domain или extend booking с
  `type='maintenance'`. Render Grey band. Backend addition.

**Complexity**: HIGH. New domain. 3-4 commits.

### Phase G10 — SSE real-time + mobile-list view

**Empirical bound source**: §3.4 SSE 2026 canon; §3.1 Bnovo live updates + offline.

**Scope**:

- **SSE endpoint**: `GET /api/v1/properties/:propertyId/events?stream=bookings`.
  YDB CDC topic → SSE → frontend `EventSource` → `queryClient.invalidateQueries`.
- **Toast on remote change** per Bnovo canon.
- **Mobile list-first view** (Hostaway canon) — separate `<ChessboardMobile>`
  component, breakpoint switch.

**Complexity**: HIGH. CDC pipeline + new transport. 4-5 commits.

### Phase G11 — Offline mode (Bnovo canon, deferred decision)

**Empirical bound source**: §3.1 Bnovo 36 days local cache (2 back + 34 forward).
Сочи infra reality.

**Scope**: PWA service worker + IndexedDB cache for last-seen grid + queue
mutations offline. Per `[[m5-tech-decisions]]` vite-plugin-pwa already canon.

**Complexity**: HIGH. Decide post-G10. Defer unless infra outage data motivates.

## §5 — Empirical signals to track (per `[[memory-is-canon-not-backlog]]`)

Each phase ships с:

- typecheck clean (4 workspaces tsgo)
- frontend unit ratio (current 1671 → +N per phase)
- e2e chromium (current 8/8 inventory + N grid/booking specs — extend per phase)
- axe WCAG 2.2 AA clean
- coverage floor 65/63/60/64 (`[[coverage-mutation-gates]]`) per touched file
- adversarial reading pass (per canon) before commit
- memory canon entries для каждого non-obvious finding/decision

## §6 — Open questions to user (BEFORE shipping G1)

1. **G1 scope confirmation**: 4 HIGH bugs одним commit OK? Or split per bug (4 commits)?
2. **Rate plan picker UX**: Select dropdown с per-plan label «Базовый · 4500₽» (Cloudbeds canon) OR radio list с full breakdown?
3. **Price preview source-of-truth (G1 stage)**: ratePlan's `currency` + per-night base = simple total OR rate-grid lookup per (planId, date) per inventory pricing grid? Real prices vary per date. G1 simple → G5 enhanced проще.
4. **Phased ordering**: G1 → G2 → G3 ... линейно? Single thread per `[[no-half-measures]]`. Phases G2 (palette) + G4 (RU overlays) могут parallel — оба data-layer-only.
5. **Phase G3 architectural shift** (Dialog → side-Sheet) — это **большое** UX change. Confirm OK с архитектурной точки или защитить current Dialog pattern? Mews/Cloudbeds canon strongly recommends side-panel, но breaks existing UX expectations.
6. **Phase G5 backend extension scope** — general `PATCH /bookings/:id` (Apaleo Amend-Stay style) OR separate endpoints (`/move-dates`, `/change-rate-plan`)? Backend service.ts canon prefers separate methods per domain operation.
7. **Phase G7 drag-create на mobile** — Hostaway product team explicitly disabled. Confirm follow canon (touch = sheet selector, не drag)?

## §7 — Resume protocol

Per `[[handover-post-push-refresh]]` — after each phase ship, update this
plan canon с DONE marker + memory canons + handover sync. After phase
approval, commit phase scope as task list (TodoWrite) + ship per
`[[adversarial-reading-before-done]]` 9-item checklist.

When phases done, mark plan §10 «closure» summary. 3. Add §8 — anti-patterns explicit list per research 4. Bring к user для phase-by-phase approval

Awaiting user signal: «G1 погнали» OR «жди research → revise plan» OR
«split G1 в 4 commits» OR other priority pivot.
