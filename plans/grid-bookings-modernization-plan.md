# Plan canon — Шахматка + Bookings modernization

**Owner**: ed (Claude Opus 4.7, 1M context).
**Created**: 2026-05-15.
**Status**: AWAITING USER APPROVAL.

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

**G-B5 — `citizenship` pattern + `documentType` free-text без enum**
[`booking-create-dialog.tsx:163-174`](apps/frontend/src/features/bookings/components/booking-create-dialog.tsx:163) — citizenship has `pattern="^[A-Z]{2,3}$"` HTML5 only (form has `noValidate` — pattern decorative). documentType is plain text. Server probably has strict enum для documentType (passportRF / foreignPassport / birthCertificate / military / driverLicense / militaryId) per МВД миграционный учёт schema. Need verification + enum Select component.

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

## §3 — Research synthesis (PLACEHOLDER — agent в фоне)

Research agent launched 2026-05-15 для май 2026 hotelier grid + booking
canons (Mews / Cloudbeds / Apaleo / Hostaway / Bnovo / TravelLine /
Stayntouch). Output должен покрыть:

1. Modern grid pattern (drag-create / drag-resize / multi-select / mobile)
2. Booking dialog/sheet pattern (Apaleo single-stay, rate plan picker, price preview, overlap live-check)
3. Technical patterns для нашего стека (virtualization Y/N, drag gesture lib)
4. RU-specific (152-ФЗ guest data в grid, туристический налог, МВД flagging)
5. Anti-patterns confirmed bad
6. Phased plan proposal с complexity ratings

Когда landing — sync здесь, update §4 phases.

## §4 — Phased plan (proposal — pending research synthesis)

### Phase G1 — HIGH severity bug fixes (no research needed, ship immediately)

**Scope**:

- Fix `useCreateGuest` silent failure → add `toast.error(extractRuMessage(err))` в onError
- Fix `guestsCount` HTML5-only → `intRangeFieldSchema({min: 1, max: 20})` через TanStack Form validator + inline FieldError
- Add rate plan picker → `<Select>` of `ratePlansQ.data.filter(isActive)`, defaults to `pickDefaultRatePlan`. Subscribe via `form.Field`
- Add live price preview → `<form.Subscribe>` reads checkIn+checkOut+ratePlanId, computes `nights × ratePlanPrice` через price-grid lookup OR rate plan's base amount. Show в footer

**Layer 4+5**: e2e в `tests/e2e/bookings.spec.ts` (existing) — extend с adversarial: guestsCount=0, =21, ratePlan picker visibility, price preview rendering, guest-create-failure toast.

**Strict tests**: exact-value messages, immutable-field (rate plan switch preserves dates), adversarial (guest 409 → toast visible).

**Complexity**: LOW. Estimated 1 commit, ~150 LoC.

### Phase G2 — MEDIUM bug fixes — input enum validation + date guards

**Scope**:

- citizenship: Select component с RU/BY/KZ/UA/UZ/TJ/AZ/AM/GE/KG/MD/TM/Other (top-10 + Other) per Сочи tourist demographics
- documentType: Select enum mirror к server (need backend schema check) — passportRF / foreignPassport / birthCertificate / military / etc
- checkIn past-date guard — `.refine((v) => v >= todayIso())` с soft-warning (operator может back-date walk-in)
- guest.firstName/lastName trim+nonEmpty + Cyrillic-or-Latin char restriction
- documentNumber per-documentType validation (passportRF: 4+6 digits regex; foreign: alphanumeric)

**Complexity**: MED. Requires shared/src/guest.ts schema audit. 1-2 commits.

### Phase G3 — Booking edit affordance (date/rate-plan/guest)

**Scope**:

- Extend ActionView с date editor (checkIn/checkOut с overlap check)
- Add rate plan switcher
- Add guest editor (link к existing guest или create new)
- TerminalView dates formatted RU
- `formatTransitionDate` no-fallback к raw ISO — show "недействительная дата" instead
- Backend: confirm `PATCH /bookings/:id` supports these field edits OR propose schema extension

**Complexity**: MED-HIGH. Backend audit required. 2-3 commits.

### Phase G4 — Drag-create + drag-resize gesture (RESEARCH-DRIVEN)

**Scope** (pending research):

- Drag-select multi-day cells → opens dialog с pre-filled range
- Drag band edges → live resize checkIn/checkOut
- Drag band middle → move booking к different roomType / dates
- Library choice (per research): @use-gesture/react vs dnd-kit vs vanilla pointer events

**Complexity**: MED-HIGH. Research informs choice. 2-3 commits.

### Phase G5 — Live overlap detection + block-cell affordance (RESEARCH-DRIVEN)

**Scope**:

- Live availability query за dialog date range
- Visual conflict highlight в grid когда dragging
- "Заблокировать номер" affordance (OOO maintenance band)
- Backend: confirm `GET /availability/check` endpoint exists OR propose

**Complexity**: HIGH. Backend coupling. 2-4 commits.

### Phase G6 — Mobile + filtering (RESEARCH-DRIVEN)

**Scope**:

- Mobile grid: stack rows OR horizontal scroll с roomType pinned
- Touch gestures: pinch-zoom date range, swipe-to-navigate weeks
- Filter affordances: by status, by guest name search
- Dialog → bottom-sheet на mobile per shadcn Drawer canon

**Complexity**: MED. Mobile UX research informs. 2 commits.

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
2. **Rate plan picker UX**: Select dropdown с per-plan label «Базовый · 4500₽» OR radio list с full breakdown? Cloudbeds canon = dropdown с inline summary.
3. **Price preview source-of-truth**: пользоваться `rate.amount` for ratePlanId+date (per inventory pricing grid) OR ratePlan's default `amount`? Real prices vary per date.
4. **Phased ordering**: G1 → G2 → G3 → ... линейно? OR G1+G2 parallel? Single thread per `[[no-half-measures]]` more sensible.

## §7 — Resume protocol

When research-agent lands:

1. Sync research findings к §3
2. Update §4 phase scope с research-informed decisions
3. Add §8 — anti-patterns explicit list per research
4. Bring к user для phase-by-phase approval

Awaiting user signal: «G1 погнали» OR «жди research → revise plan» OR
«split G1 в 4 commits» OR other priority pivot.
