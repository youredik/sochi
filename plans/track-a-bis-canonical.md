# Track A.bis — Hotelier Admin App-Shell Sidebar (canonical sub-phase plan)

**Дата:** 2026-05-12 (POST-AUDIT corrections appended same day)
**Track:** A.bis (вставляется между Track A ✅ done и Track B deploy — per `plans/ROADMAP.md` future amend).

> **POST-AUDIT (2026-05-12, после b396ac0):** Empirical recon ui/ folder caught 4 factual errors в v1 plan. §0 Codebase state добавлен (new canon `feedback_pre_plan_codebase_recon.md`). Decisions D2-D5 + §3 + §5 + §13 + §7 sub-phase scope обновлены ниже. См. §16 process correction C32+.

---

## §0. Codebase state (empirical recon 2026-05-12) — MANDATORY (per `feedback_pre_plan_codebase_recon.md`)

**Existing `apps/frontend/src/components/ui/` inventory** (24 files, 2247 LOC, всё verified `wc -l` + Read):

| File | LOC | Implementation | Status для A.bis |
|---|---|---|---|
| `sheet.tsx` | 147 | **Radix Dialog**-based (`from 'radix-ui'`) — `<Sheet>`, `<SheetTrigger>`, `<SheetClose>`, `<SheetContent side="top/right/bottom/left">`, `<SheetHeader>`, `<SheetFooter>`, `<SheetTitle>`, `<SheetDescription>`, `<SheetOverlay>`, `<SheetPortal>`. Includes built-in close button `<XIcon>` via `showCloseButton?` prop | **EXISTS — re-use as-is** (was wrongly planned as «create» в v1) |
| `drawer.tsx` | 132 | **Vaul**-based (`from 'vaul'`) — same API surface as Sheet | **DROP** target (rewrite OR delete после responsive-sheet migration) |
| `responsive-sheet.tsx` | 126 | **useMediaQuery bifurcation** (`'(min-width: 768px)'`) — desktop → Sheet (Radix), mobile → Drawer (Vaul). Context-shared `isMobile`. Drop-in API. Consumers: `consent-block.tsx`, `refund-sheet.tsx`, `migration-registration-detail-sheet.tsx` | **EXISTS** — already bifurcates (was wrongly planned to «split» в v1). Only underlying `drawer.tsx` impl changes |
| `dialog.tsx` | 101 | Radix Dialog wrapper (modal, не side-sheet) | unchanged |
| `tooltip.tsx` | 55 | `from 'radix-ui'` Tooltip — used by shadcn sidebar collapsed-rail labels | re-use |
| `popover.tsx`, `tabs.tsx`, `radio-group.tsx`, `toggle-group.tsx`, `label.tsx`, `separator.tsx`, `card.tsx`, `field.tsx`, `calendar.tsx`, `alert.tsx`, `badge.tsx`, `dropdown-menu.tsx`, `select.tsx`, `button.tsx`, `toggle.tsx`, `checkbox.tsx`, `textarea.tsx`, `input.tsx`, `skeleton.tsx` | total ~1600 | All `from 'radix-ui'` unified imports | re-use |

**Existing `apps/frontend/package.json` (verified `cat`):**
- `react ^19.2.5` ✓
- **`radix-ui ^1.4.3`** (verified npm: 2025-12-17, MIT) — **UNIFIED Radix package**, exposes all primitives via subpath imports (`import { Dialog as ... } from 'radix-ui'`). Already used by 10 existing `ui/*.tsx` files (verified grep). Means: **NO need ADD separate `@radix-ui/react-*` packages** (Major correction vs v1 plan D2-D5).
- `tailwindcss ^4.2.4` ✓ (bump candidate 4.3.0)
- `lucide-react ^1.11.0` ✓ (bump candidate 1.14.0)
- `vaul 1.1.2` ✓ DROP target (used by drawer.tsx)
- `@lingui/react ^6.0.0` ✓ (NOT v5 as memory `project_m5_tech_decisions.md` claims — drift fix obligation)
- `radix-ui ^1.4.3` — verified subpath `import { Collapsible as ... } from 'radix-ui'` works (verified `npm view radix-ui exports` shows `'./*'` wildcard)
- **NEW deps required**: `@base-ui/react ^1.4.1` (Base UI Drawer для widget swipe-to-dismiss UX preservation — verified npm 2026-04-20, MIT)

**Vaul consumers (verified grep):**
- `apps/frontend/src/components/ui/drawer.tsx` (wrapper) — DROP target
- `apps/frontend/src/components/sidebar-drawer.tsx` (admin) — DELETE entirely в A.bis.2 (заменяется shadcn `<Sidebar collapsible="offcanvas">`)
- `apps/frontend/src/features/public-widget/components/sticky-summary.tsx` (widget guest mobile summary) — DIRECT Drawer usage, needs migration
- Indirect via `ResponsiveSheet`: `consent-block.tsx`, `refund-sheet.tsx`, `migration-registration-detail-sheet.tsx` — **transparent migration** (если drawer.tsx меняется под `ResponsiveSheet`)

**Existing nav/layout (verified Read):**
- `routes/__root.tsx` (20 lines) — simple `<Outlet/>` shell
- `routes/_app.tsx` (132 lines) — `MobileNav` + `SidebarDrawer` + top-bar + `InstallPrompt` + `OrgSwitcher` + `LogoutButton` + `ModeToggle`
- `routes/_app.o.$orgSlug.tsx` (35 lines) — tenant guard only (`setActive` if URL slug ≠ session)
- `routes/_app.o.$orgSlug.index.tsx` (153 lines) — dashboard tiles (5 visible: Шахматка/Дебиторка/Тур.налог/Уведомления/Профиль)
- `components/mobile-nav.tsx` + `mobile-nav-button.tsx` + `mobile-nav-state.ts` + `sidebar-drawer.tsx` — DELETE candidates (replaced by shadcn `<Sidebar>`)

**Existing routes (`find apps/frontend/src/routes`):** 25 files total. Admin routes available:
- `_app.o.$orgSlug.index.tsx` (dashboard)
- `_app.o.$orgSlug.grid.tsx` (Шахматка)
- `_app.o.$orgSlug.receivables.tsx`
- `_app.o.$orgSlug.properties.$propertyId.content.tsx`
- `_app.o.$orgSlug.admin.migration-registrations.tsx`
- `_app.o.$orgSlug.admin.channels.tsx`
- `_app.o.$orgSlug.admin.tax.tsx`
- `_app.o.$orgSlug.admin.notifications.tsx`
- `_app.o.$orgSlug.account.security.tsx`
- `_app.o.$orgSlug.bookings.$bookingId.folios.$folioId.tsx`
- `_app.o.$orgSlug.setup.tsx`

**RBAC** (verified Read `packages/shared/src/rbac.ts` 143 lines):
- 3 roles: owner / manager / staff
- Resources: property, room, ratePlan, booking, guest, folio, payment, refund, receipt, report, notification, billing, compliance, amenity, description, media, addon, migrationRegistration
- **No `settings` resource** (verified grep empty)
- staff has `migrationRegistration:read` (rbac.ts:116) — для front-desk видимости заселения
- staff does NOT have `notification:read` (rbac.ts:107)

---
**Scope:** Desktop persistent app-shell sidebar для hotelier admin (`/o/:slug/*`), Vaul→Sheet/BaseUI migration, dashboard refactor «tiles внутри content», RBAC × sidebar, демо/прод badge, RU a11y canon.
**Canonical guard:** `feedback_engineering_philosophy.md` (production-grade с первой строчки) + `feedback_aggressive_delegacy.md` (Vaul UNMAINTAINED — миграция обязательна) + `feedback_behaviour_faithful_mock_canon.md` (sidebar identical для demo + production tenants).
**Research:** R1 (UX/UI canon ≥2026-05-12, 28 sources) + R2 (tech primitives + npm-verify ≥2026-05-12, all pkgs empirically curl'нуты) + R3 adversarial (18 D-corrections к R1+R2) + **R4 empirical-verify** (3 R3-неточности пойманы: Radix dec'25 не aug'25; Base UI pkg name `@base-ui/react` не `@base-ui-components/react`; PR #6798 closed unmerged, не merged). 22+ corrections к baseline mental-model.

---

## §1. North-star alignment (зачем эта фаза)

**Mission link** (`project_initial_framing.md` 7×3 mandate): Track A закрыл 6/7 функций end-to-end **на бэкенде + публичный виджет** (гость-facing). Но **hotelier-facing admin UX** имеет 3 P0-gap'а из финального аудита 2026-05-12:

1. **Rate / Availability daily calendar** — нельзя менять цены/доступность после setup → блокер для эксплуатации Боли 2.2/2.3
2. **Inventory CRUD после setup** — нельзя добавить номер/тариф → блокер для роста hotel inventory
3. **Channels недискаверабельны на desktop** — Боль 2.2 в UI невидима для владельца через стандартный flow (admin/channels accessible only через прямой URL)

Эта фаза (A.bis) — **архитектурная foundation для всех трёх** через **proper app-shell sidebar**. Без неё каждая будущая admin-страница (rate-calendar, inventory CRUD) повторит тот же discoverability gap.

**Что эта фаза НЕ закрывает напрямую**:
- Rate/availability calendar UI — отдельная sub-phase **после** sidebar лендинга
- Inventory CRUD UI — отдельная sub-phase
- Channel setup wizard + roomType mapping UI — отдельная sub-phase

Эта фаза **разблокирует** все 3 (даёт стабильный nav-фундамент), но сам по себе их код не пишет.

**Демо surface canon** (`project_demo_strategy.md`): sidebar identical для demo + production tenants. Demo тенант видит тот же app-shell, тот же набор разделов (RBAC matrix не зависит от mode). В `<SidebarFooter>` показывается `[DEMO]` / `[LIVE]` pill — операционная видимость mode'а tenant'а.

---

## §2. Integration map — что A.bis hooks (минимальное вмешательство)

| Existing artifact | Used by A.bis |
|---|---|
| `_app.tsx` (authenticated shell, 132 строки) | Перестраивается: `<SidebarProvider>` + `<Sidebar>` + `<SidebarInset>` оборачивают `<Outlet/>` |
| `_app.o.$orgSlug.tsx` (tenant guard, 35 строк) | Не трогаем (только tenant validation) |
| `_app.o.$orgSlug.index.tsx` (dashboard, 153 строки) | Рефакторится: tiles → KPI cards внутри content (R1 §1.4 canon «tiles inside content area») |
| `MobileNav.tsx` (mobile bottom-tab) | **Удаляется** — `<Sidebar collapsible="offcanvas">` сам обслуживает mobile |
| `SidebarDrawer.tsx` (mobile More-drawer) | **Удаляется** — те же destination'ы переезжают в `<SidebarMenuGroup>` |
| `ui/drawer.tsx` (Vaul wrapper, 3 consumers) | **Split в 2 файла**: `ui/sheet.tsx` (Radix Dialog) для admin + `ui/widget-drawer.tsx` (Base UI Drawer) для public widget |
| `ui/responsive-sheet.tsx` (shared) | Рефакторится — delegates в `ui/sheet.tsx` для admin path |
| `features/public-widget/components/sticky-summary.tsx` (Vaul drawer для guest) | Мигрирует на `ui/widget-drawer.tsx` (Base UI 1.4.1 GA с swipeDirection) |
| 25 существующих admin routes (`_app.o.$orgSlug.*`) | Не трогаем код роутов — только их discoverability через sidebar nav |
| `packages/shared/src/rbac.ts` (3 роли × resources × actions) | Не трогаем — sidebar items conditionally hidden через `hasPermission()` |

**Я НЕ создаю**: backend endpoints, новые domains, новые миграции (sidebar = pure frontend re-organization).

**Я создаю**:
- `apps/frontend/src/components/ui/sidebar.tsx` — shadcn sidebar primitive CLI-output + **5 локальных патчей** (см. §4 D-corrections)
- `apps/frontend/src/components/ui/sheet.tsx` — Radix Dialog wrapper (Vaul replacement для admin)
- `apps/frontend/src/components/ui/widget-drawer.tsx` — Base UI Drawer wrapper (Vaul replacement для public widget с drag-to-dismiss)
- `apps/frontend/src/components/app-shell/admin-sidebar.tsx` — наш sidebar instance с 10 destination'ами + RBAC + demo badge
- `apps/frontend/src/components/app-shell/sidebar-sections.ts` — canonical RU labels + lucide icon mapping + permission gates
- Тесты: unit + axe matrix + Playwright e2e + visual smoke 4 viewports

---

## §3. Что реально пишется (file-level breakdown)

### Frontend (8 новых файлов + 7 refactor'ов)

| File | Создание / Refactor | Назначение |
|---|---|---|
| `ui/sidebar.tsx` | NEW (shadcn CLI + 5 patches) | Sidebar primitive — `<SidebarProvider>`, `<Sidebar>`, `<SidebarMenu>`, `<SidebarMenuButton>`, `<SidebarMenuSub>`, `<SidebarFooter>`, `<SidebarHeader>`, `<SidebarInset>`, `useSidebar()` hook |
| `ui/sheet.tsx` | NEW (shadcn CLI) | Radix Dialog wrapper — `<Sheet>`, `<SheetTrigger>`, `<SheetContent side="left\|right\|top\|bottom">`, `<SheetClose>`. Admin path. |
| `ui/widget-drawer.tsx` | NEW (Base UI 1.4.1 GA) | Base UI Drawer с `swipeDirection="down"`, `snapPoints`, drag-to-dismiss. Public widget path. |
| `app-shell/admin-sidebar.tsx` | NEW | Наш sidebar instance: 10 destinations + 2-level nesting (Каналы → TL/YT/ETG) + RBAC gates + demo/prod badge + OrgSwitcher в `<SidebarHeader>` |
| `app-shell/sidebar-sections.ts` | NEW | Canonical RU labels + lucide icons + permission predicates + route paths (single source of truth) |
| `app-shell/demo-mode-badge.tsx` | NEW | Pill `[DEMO]` / `[LIVE]` для `<SidebarFooter>` (читает `useCurrentOrg().mode`) |
| `_app.tsx` | REFACTOR | `<SidebarProvider defaultOpen>` + `<AdminSidebar>` + `<SidebarInset>` оборачивают `<Outlet/>`. Удаляется top-bar (его роль перенимает SidebarHeader). |
| `_app.o.$orgSlug.index.tsx` | REFACTOR | Dashboard tiles → KPI cards внутри content area. Главная страница теперь = реальный dashboard (Occupancy/ADR/RevPAR placeholders + Recent activity + Alerts), не nav-хаб. |
| `components/sidebar-drawer.tsx` | DELETE | Заменяется `<Sidebar collapsible="offcanvas">` (single component handles mobile + desktop) |
| `components/mobile-nav.tsx` | DELETE | То же |
| `components/mobile-nav-button.tsx` | DELETE | То же |
| `components/mobile-nav-state.ts` | DELETE | То же |
| `ui/drawer.tsx` | DELETE | Все 3 consumer'а мигрировали на `ui/sheet.tsx` или `ui/widget-drawer.tsx` |
| `ui/responsive-sheet.tsx` | REFACTOR | Delegates в `ui/sheet.tsx` (admin only — widget использует напрямую `ui/widget-drawer.tsx`) |
| `features/public-widget/components/sticky-summary.tsx` | REFACTOR | Vaul → Base UI Drawer (`ui/widget-drawer.tsx`) |
| `features/admin-migration-registrations/components/migration-registration-detail-sheet.tsx` | REFACTOR | Vaul Drawer → Radix Sheet (changes только импорт + слегка JSX) |

### Тесты

- `ui/sidebar.test.tsx` — unit: `<SidebarProvider defaultOpen>` mount, `useSidebar().toggleSidebar()`, cookie persistence, controlled-prop bug guard (D-9)
- `ui/sheet.test.tsx` — unit: side variants, ESC, outside-click, focus-trap (Radix Dialog reuses focus-trap)
- `ui/widget-drawer.test.tsx` — unit + browser mode: swipeDirection works, snapPoints rendered
- `app-shell/admin-sidebar.test.tsx` — RBAC × 3 roles × 10 sections (30 visibility assertions, strict per `feedback_strict_tests.md`)
- `app-shell/admin-sidebar.test.tsx` — keyboard: Cmd+B toggle, arrow nav per Disclosure Hybrid pattern
- `_app.test.tsx` — refactor regression: `<AdminSidebar>` mounts на authenticated paths, не mount'ится на login/signup
- `e2e/admin-sidebar-discoverability.spec.ts` — Playwright: каждый из 10 destinations reachable через sidebar nav (was previously МВД + Channels только URL)
- `e2e/admin-sidebar-axe.spec.ts` — axe matrix 12 cells (3 themes × 4 viewports) — WCAG 2.2 AA
- `e2e/admin-sidebar-visual.spec.ts` — visual smoke 4 viewports (320/768/1024/1440) — Lost-Pixel против baseline

**Target test count:** ~80 unit/integration + 12 e2e (axe + visual + discoverability). За A.bis всего 90+ strict tests (~ план m9_widget_8 уровень).

---

## §4. Decisions D1-D40 (final, post R1+R2+R3 + R4 empirical-verify)

### Library / package canon

- **D1** — Primitive: **shadcn-ui sidebar via CLI** (`pnpm dlx shadcn@latest add sidebar`). In-repo source, owned. NOT Mantine AppShell / Park UI / React Aria Components (rationale в §15 alternatives reconsidered).
- **D2** — Sheet (admin Vaul replacement): **`ui/sheet.tsx` УЖЕ существует** (147 lines, `from 'radix-ui'` Dialog primitive). Re-use as-is. NO new pkg add (per §0 codebase recon). **POST-AUDIT correction v1 D2 wrongly said «ADD @radix-ui/react-dialog»**.
- **D3** — Sub-menu nesting: `import { Collapsible as ... } from 'radix-ui'` — unified pkg already covers (verified `npm view radix-ui exports` shows `'./*'` wildcard). NO separate ADD. **POST-AUDIT correction v1 D3 wrongly said «ADD @radix-ui/react-collapsible»**.
- **D4** — Collapsed-rail tooltips: **`ui/tooltip.tsx` УЖЕ существует** (55 lines, `from 'radix-ui'`). Re-use. **POST-AUDIT correction v1 D4 wrongly said «ADD @radix-ui/react-tooltip»**.
- **D5** — asChild composition: `import { Slot } from 'radix-ui'` already used by `ui/badge.tsx:3` (verified grep). NO separate ADD. **POST-AUDIT correction v1 D5 wrongly said «ADD @radix-ui/react-slot»**.
- **D6** — Widget Vaul replacement: **`@base-ui/react` 1.4.1 GA** (npm-verified 2026-04-20, MIT) — **NOT `@base-ui-components/react` (still rc.0 from Dec 2025 — R3 cited wrong pkg)**. Has `Drawer` с `swipeDirection`, `snapPoints`, `--drawer-swipe-movement-y` CSS var.
- **D7** — Icons: **`lucide-react`** bump **1.11.0 → 1.14.0** (npm-verified 2026-04-29, ISC). Tree-shakeable per-icon.
- **D8** — Tailwind: bump **`tailwindcss` 4.2.4 → 4.3.0** (npm-verified 2026-05-11, MIT — **published вчера**). Container queries fully GA в 4.3.
- **D9** — DROP **`vaul` 1.1.2** (UNMAINTAINED README explicit, 17mo stale 2024-12-14, Issue #647 May 2026 open, Issue #8507 iOS PWA). DROP from `package.json`.
- **D10** — Command palette (Cmd+K): **OUT of A.bis scope полностью**. cmdk 1.1.1 8.5mo stale + Cyrillic ranking broken (#146 + #107). Внедрение требует custom Cyrillic ranker + transliteration → отдельная feature-фаза когда / если landing. NOT halfmeasure-deferred — просто не в scope этой архитектурной фазы.
- **D11** — Split-pane panels: **DEFER** (`react-resizable-panels` 4.11.0 verified, но split-pane не нужен в A.bis. Activation когда придёт Шахматка timeline 2D split).

### shadcn-ui sidebar known bugs — 5 локальных патчей в `ui/sidebar.tsx`

- **D12** — Issue **#6761** (OPEN, mobile collapsible="offcanvas" нет focusable dismiss → SR users TRAPPED) — **PR #6798 был closed unmerged 2026-03-07 stale-bot** (R3 ошибся утверждая merge). **Patch:** manually add visible focusable `<X>` close button в `<SheetContent>` overlay shadcn sidebar source (мы owner copy). Test: Playwright tab-loop scenario.
- **D13** — Issue **#8176** (OPEN, cookie не respected на reload с controlled `open` prop) — **Patch (preventive):** в `<SidebarProvider>` использовать **только `defaultOpen`** (uncontrolled), НИКОГДА `open`/`onOpenChange` props. Linter rule (eslint custom) для enforce.
- **D14** — Issue **#9335** (OPEN, multiple `<SidebarProvider>` siblings share `sidebar_state` cookie + Cmd+B shortcut → toggle together) — **Patch (preventive):** project canon **ровно один `<SidebarProvider>`** в `_app.tsx`. Документировать в CLAUDE.md-equivalent (но не в repo per `feedback_no_claude_in_repo.md` — в этом файле + dependency-cruiser rule).
- **D15** — **aria-label explicit Cyrillic** на каждом `<SidebarMenuButton>` (R3 D-5) — tooltip = `aria-describedby` (secondary), SR читают `aria-label` (primary). Хардкод в `sidebar-sections.ts`. Test: axe SR canonical name.
- **D16** — `forced-colors: active` (Windows High Contrast Mode) — collapsed icon buttons получают `border-[ButtonText]` (per existing process correction #13 от M9.widget.2). Test: Playwright `forced-colors: active` viewport.

### Architecture decisions

- **D17** — Breakpoint: sidebar emerges на **`md:` (768px)** — **domain-specific override** generic R2 canon (lg: 1024px). Rationale: Front-desk hotel operations часто on **10" tablets (~768-1024px)** — persistent sidebar на tablet > hidden offcanvas mobile UX. R2's `lg:` canon рассчитан на pure-desktop B2B (Linear/Vercel/Stripe), **не PMS daily operations**. Cloudbeds/Mews/Bnovo также allow tablet sidebar persistence. Project canon `md:` существует не от legacy, а от deliberate PMS UX decision M9. Mobile **<768px** (phones) использует `<Sidebar collapsible="offcanvas">`. **Capture в §14 risks**: senior trade-off generic-canon vs domain-specific UX. Empirical scope: ~6 admin `md:` references (`_app.tsx:98,102` + `install-prompt.tsx:24,69` + new sidebar + mobile-nav будет deleted). Widget breakpoints (extras/search-and-pick/guest-and-pay) — independent concern, stay `md:` для guest UX.
- **D18** — Mobile + desktop = **single component** (`<Sidebar collapsible="offcanvas">`). НЕТ форк-кода mobile-nav vs desktop-sidebar. Уход от существующих 4 файлов (mobile-nav, mobile-nav-button, mobile-nav-state, sidebar-drawer).
- **D19** — Width: **256px expanded / 64px collapsed icon-rail**. Per R1 canon (Linear/Vercel/Cloudbeds).
- **D20** — Cookie state: **best-effort persistence**. Safari ITP 2.3 caps client-set cookies at 7 days; 30+ days idle clears all storage. Document explicit «sidebar collapsed state не durable». NOT 152-ФЗ PII (boolean, no user identifier → не tracking cookie per Roskomnadzor).
- **D21** — A11y pattern: **W3C APG Disclosure Hybrid** (`aria-expanded` + nav role panel), NOT `role="menu"` (transient menubar semantics). R1 §1.5 + R3 §A3 canon.
- **D22** — `aria-current="page"` emit: **TanStack `<Link>` auto-emits** через `data-status="active"` + `aria-current="page"` если установлено `activeProps={{ 'aria-current': 'page' }}`. **MUST set `activeOptions={{ exact: true }}` на parent group Links** (R3 D-4) — иначе double-current при nested route (`/admin/channels` + `/admin/channels/:id`).
- **D23** — Keyboard: shadcn sidebar default Cmd+B toggle. НЕ переопределяем (Cmd+K reserved для будущего command palette).
- **D24** — Cross-tab broadcast: NOT нужен для sidebar state (low-value sync; existing `BroadcastChannel` оставляем только для logout / org-switch per `_app.tsx:71-83`).
- **D25** — `<SidebarHeader>`: содержит OrgSwitcher (мульти-tenant, mounted внутри `<DropdownMenu>`) per R3 D-13 — НЕ в top-bar (Linear/Vercel canon).
- **D26** — `<SidebarFooter>`: содержит `[DEMO]`/`[LIVE]` pill + LogoutButton + ModeToggle (theme switcher).
- **D27** — Top-bar выше `<SidebarInset>` content: **удаляется** (его роль теперь у SidebarHeader). Освобождает vertical space на mobile (важно для шахматки).

### Sections / RBAC — **CORRECTED: 7 active items only, no vapor**

- **D28** — **7 destinations** (только currently-existing routes per empirical `find apps/frontend/src/routes` 2026-05-12; NO disabled-future per `feedback_no_halfway.md`):
  1. **Шахматка** (`/o/:slug/grid`) — `booking:read` (все роли)
  2. **Дебиторка** (`/o/:slug/receivables`) — `report:read` (manager+) или `booking:read` (если нет report:read у staff to view receivables — verify в A.bis.2)
  3. **Профиль гостиницы** (`/o/:slug/properties/{firstId}/content`) — `compliance:read OR amenity:read` (existing pattern из `index.tsx:44-46`)
  4. **Гости (МВД)** (`/o/:slug/admin/migration-registrations`) — `migrationRegistration:read` (все роли — staff has read per rbac.ts:116)
  5. **Каналы дистрибуции** (`/o/:slug/admin/channels`) — `report:read` (manager+) — sub-menu (TL/YT/ETG via Collapsible) если sub-routes exist в A.bis.2 time
  6. **Туристический налог** (`/o/:slug/admin/tax`) — `report:read` (manager+)
  7. **Уведомления** (`/o/:slug/admin/notifications`) — `notification:read` (manager+ — staff не granted per rbac.ts:107)
- **D29** — **RBAC × sidebar visibility**: items с `hasPermission()` false → `hidden` (NOT just disabled-styled — полностью убираем из DOM). Staff sees 3 (Шахматка/Гости/Профиль).
- **D30** — **NO disabled-future sections** (vapor links = halfmeasure per `feedback_no_halfway.md`). Sidebar расширяется **incrementally** — каждая будущая sub-phase (rate-calendar / inventory-CRUD / payments / settings / activity) добавляет свою sidebar entry в составе своего commit'а. Pattern: «route + sidebar item в одном PR».
- **D30.1** — Будущие routes (Bookings filter / Rates / Inventory / Payments / Settings / Activity) **НЕ упоминаются** в `sidebar-sections.ts` до lands. `feedback_no_halfway.md` enforced.

### Demo / production

- **D31** — `<DemoModeBadge>` в `<SidebarFooter>`: читает `useCurrentOrg().mode` (existing `organization.mode` column в DB per `M8.A.demo`). Pill colors: `[DEMO]` = amber, `[LIVE]` = emerald. aria-label canonical: «Демо-режим» / «Продакшн-режим».
- **D32** — Demo тенант видит **тот же набор destinations** что и production тенант (consistency: prospect видит full PMS, не crippled версию). RBAC matrix unchanged.

### Test pyramid

- **D33** — Unit: ~50 strict tests (sidebar component + sheet component + widget-drawer + RBAC × sections matrix + cookie patch + controlled-prop guard).
- **D34** — Integration: `_app.test.tsx` refactor regression + `admin-sidebar.test.tsx` mount + RBAC matrix.
- **D35** — Playwright e2e: discoverability (10 destinations clickable from sidebar) + Cmd+B toggle + nested-route active highlight + mobile offcanvas open/close.
- **D36** — axe matrix: 12 cells (3 themes × 4 viewports) covering desktop sidebar + mobile offcanvas variants. Required: zero violations WCAG 2.2 AA.
- **D37** — Visual smoke: 4 viewports (320/768/1024/1440) — Lost-Pixel или Playwright snapshot canonical 2026.
- **D38** — forced-colors test: дополнительный Playwright spec с `colorScheme: 'forced-colors'` для D16 patch verification.

### Process

- **D39** — Sub-phase decomposition (см. §7 ниже) — A.bis.0..A.bis.5 (+ A.bis.6 defer). Каждая sub-phase = 1 commit с paste-and-fill audit checklist в commit body.
- **D40** — Per-sub-phase R1+R2 freshness check **обязателен** перед каждым sub-phase commit (canonical pattern от M9.widget.6 — 6 fresh corrections surfaced thus). Cache R1+R2 от today (2026-05-12) valid в течение 5 дней per `feedback_research_strictness_today.md`.

---

## §5. Library canon — empirically npm-verified 2026-05-12

| Package | Action | Final version | Published | License | npm-verified |
|---|---|---|---|---|---|
| `vaul` | DROP | — | 2024-12-14 (17mo stale) | MIT | ✓ confirmed unmaintained |
| `tailwindcss` | BUMP `^4.2.4` → `^4.3.0` | 4.3.0 | **2026-05-11** | MIT | ✓ |
| `lucide-react` | BUMP `^1.11.0` → `^1.14.0` | 1.14.0 | 2026-04-29 | ISC | ✓ |
| `radix-ui` (unified) | **KEEP `^1.4.3`** — already in deps | 1.4.3 | 2025-12-17 | MIT | ✓ (§0 recon caught: subpath imports `from 'radix-ui'` cover Dialog/Collapsible/Tooltip/Slot — NO separate ADD per pkg) |
| `@base-ui/react` | ADD `^1.4.1` (для widget swipe UX) | 1.4.1 | 2026-04-20 | MIT | ✓ (R3 cited wrong pkg name) |
| `react-resizable-panels` | DEFER | (4.11.0 verified 2026-05-02) | — | MIT | ✓ |
| `cmdk` | OUT of scope | (1.1.1, 2025-08-27 stale + Cyrillic broken) | — | MIT | ✓ |
| `react-aria-components` | REJECT | (1.17.0, 2026-05-08) | — | Apache-2.0 | ✓ alternative considered |
| `@nozbe/microfuzz` | DEFER | (1.0.0, 2024-06-14) | — | MIT | ✓ stale-ish |
| `cyrillic-to-translit-js` | REJECT | (3.2.1, 2022-06-14 4yr stale) | — | MIT | ✓ — replace с 30-line custom |

**Net `package.json` change для A.bis.0..A.bis.5** (POST-AUDIT corrected):
- DROP: 1 pkg (vaul)
- BUMP: 2 pkgs (tailwindcss, lucide-react)
- ADD: **1 pkg (@base-ui/react)** — NOT 5 (Radix primitives already covered unified pkg)
- **Total: 4 mutations** (NOT 8 as v1 plan claimed)

Все **4 mutations** (POST-AUDIT corrected, было 8 в v1 plan) в `apps/frontend/package.json` — единым diff в A.bis.0 commit.

---

## §6. Architecture — component hierarchy

```
<RootLayout> (__root.tsx)
└── <Outlet/>
    └── <AppLayout> (_app.tsx — REFACTORED)
        ├── <SidebarProvider defaultOpen>   ← NEW
        │   ├── <AdminSidebar>              ← NEW
        │   │   ├── <SidebarHeader>
        │   │   │   └── <OrgSwitcher/>      ← moved from top-bar
        │   │   ├── <SidebarContent>
        │   │   │   ├── <SidebarGroup>      ← 10 sections с RBAC + Collapsible nesting
        │   │   │   │   ├── <SidebarMenu>
        │   │   │   │   │   ├── <SidebarMenuItem> × 10
        │   │   │   │   │   │   ├── <SidebarMenuButton asChild>
        │   │   │   │   │   │   │   └── <Link to={section.path} activeProps={...} activeOptions={{exact:true}}/>
        │   │   │   │   │   │   └── [Collapsible sub-menu для Каналы]
        │   │   │   │   │   │       └── <SidebarMenuSub>
        │   │   │   │   │   │           └── <SidebarMenuSubItem> × 3 (TL/YT/ETG)
        │   │   ├── <SidebarFooter>
        │   │   │   ├── <DemoModeBadge/>    ← NEW
        │   │   │   ├── <ModeToggle/>       ← existing (theme switch)
        │   │   │   └── <LogoutButton/>     ← moved from top-bar
        │   ├── <SidebarInset>             ← content wrapper
        │   │   ├── <Outlet/>              ← все routes /o/:slug/* рендерятся внутри
        │   │   └── <InstallPrompt/>       ← existing (PWA hint)
```

**Mobile (<768 px) — explicit `<SidebarTrigger>` mount (self-audit A5 correction):** shadcn-canonical pattern требует explicit trigger placement (НЕТ auto-hamburger per WebFetch shadcn docs 2026-05-12). Top-bar НЕ удаляется полностью, а становится **minimal mobile-only header**:

```
<div className="md:hidden border-b border-border bg-background/80 pt-safe-top sticky top-0 z-40 backdrop-blur">
  <div className="flex items-center justify-between px-4 py-3">
    <SidebarTrigger aria-label="Меню" />
    <span className="text-sm font-semibold">HoReCa</span>
    {/* OrgSwitcher live в SidebarHeader, на mobile открывается через trigger */}
  </div>
</div>
```

Desktop (`md:` and up): sidebar persistent visible, `<SidebarTrigger>` НЕ нужен (Cmd+B для collapse/expand).

---

## §7. Sub-phase decomposition

| # | Sub-phase | Scope | Strict tests target | Commit |
|---|---|---|---|---|
| **A.bis.0** | Vaul migration prep (**POST-AUDIT scope corrected**) | (a) **DROP vaul**. (b) **BUMP tailwindcss + lucide-react**. (c) **ADD @base-ui/react ^1.4.1** для widget swipe UX. (d) **Rewrite `ui/drawer.tsx`** — Vaul → Base UI Drawer subpath `from '@base-ui/react/drawer'` с swipeDirection + snapPoints. (e) `ui/sheet.tsx` + `ui/responsive-sheet.tsx` **re-use as-is** (existing per §0 codebase recon). (f) Migrate `sticky-summary.tsx` direct Drawer consumer (drop-in import). (g) `consent-block.tsx` + `refund-sheet.tsx` + `migration-detail-sheet.tsx` — **transparent migration** через ResponsiveSheet (no consumer change). (h) `sidebar-drawer.tsx` admin — НЕ trogаем, DELETE в A.bis.2. | ~15 unit | 1 |
| **A.bis.1** | shadcn sidebar primitive | shadcn CLI add sidebar → `ui/sidebar.tsx`. Apply 5 patches (D12-D16). Unit tests covering controlled-prop guard, cookie persistence, aria-label, forced-colors, mobile dismiss button. | ~20 unit + a11y | 1 |
| **A.bis.2** | App-shell integration | `<SidebarProvider>` в `_app.tsx`. Build `app-shell/admin-sidebar.tsx` + `sidebar-sections.ts` + `demo-mode-badge.tsx`. RBAC × sections matrix. 10 destinations (8 active routes + 2 disabled-placeholder). Delete mobile-nav.tsx + mobile-nav-button.tsx + mobile-nav-state.ts + sidebar-drawer.tsx. | ~30 integration | 1 |
| **A.bis.3** | Dashboard refactor | `_app.o.$orgSlug.index.tsx` — tiles → KPI cards внутри content. Главная превращается в реальный dashboard (Occupancy/ADR/RevPAR placeholders, Recent activity list читает activity domain, Alerts читает notification outbox). | ~15 unit | 1 |
| **A.bis.4** | E2E + axe matrix + visual | Playwright spec: discoverability (10 destinations clickable from sidebar), keyboard Cmd+B, nested-route active highlight, mobile offcanvas. axe matrix 12 cells. Visual smoke 4 viewports. forced-colors spec. | 12 e2e | 1 |
| **A.bis.5** | Closure + memory | (a) Update `plans/ROADMAP.md` — insert Track A.bis between A и B. (b) New memory `project_a_bis_done.md`. (c) Process corrections capture. (d) **Update `project_locked_versions.md`** — bumps + adds. (e) **Update `project_architecture_decisions.md`** — app-shell architecture decision + D17 breakpoint trade-off rationale. (f) **Update `project_m5_tech_decisions.md`** — Lingui v5→v6 drift fix. (g) **`pnpm outdated --recursive`** + flag deprecated (per `feedback_dependency_freshness.md`). (h) Coverage floor bump check. (i) Final `pnpm test:serial` + `pnpm e2e:smoke` + `pnpm dev-doctor` green. | n/a | 1 |

**cmdk command palette: OUT of A.bis entirely** (per fix #1 — не halfmeasure-deferred sub-phase, просто не в scope этой архитектурной фазы). Возвращается когда / если Cyrillic-ranker готов + product validates demand.

**Cumulative target:** ~90+ unit/integration + 12 e2e = **102+ strict tests** для A.bis full closure. Соответствует уровню M9.widget.6 (117 strict + 8 e2e).

**Test loop canon (explicit per `feedback_test_loop_canon.md`):**
- Каждый sub-phase commit body: `pnpm test:fast` (~47s, no-db) — default verification.
- A.bis.5 closure: full `pnpm test:serial` (~500s, single shared YDB) + `pnpm e2e:smoke` (Playwright + axe AA matrix) + `pnpm dev-doctor` (pre-push gate).
- НЕ запускать `pnpm test:serial` мид-таск per sub-phase — overhead не оправдан (frontend-only changes, no backend tests stressed). 

---

## §8. Test pyramid spec (canon strict per `feedback_strict_tests.md`)

### Unit (~50 tests)

- `ui/sidebar.test.tsx` — 12 tests (provider mount, useSidebar hook, cookie persistence, controlled-prop guard, Cmd+B keyboard, defaultOpen variants, collapsible="icon" vs "offcanvas")
- `ui/sheet.test.tsx` — 6 tests (side variants, ESC, outside-click, focus-trap, modal=true canonical)
- `ui/widget-drawer.test.tsx` — 6 tests (swipeDirection canonical, snapPoints, drag-to-dismiss, Shadow DOM compat skip if iframe)
- `app-shell/admin-sidebar.test.tsx` — RBAC × sections: 3 roles (owner/manager/staff) × 10 sections = 30 visibility assertions (exact-value, не >=).
- `app-shell/demo-mode-badge.test.tsx` — demo/live/missing-mode (3 cases)
- `_app.test.tsx` — refactor regression (SidebarProvider mounts, Outlet renders, login/signup исключены)

### Integration (~20 tests)

- `admin-sidebar.test.tsx` — full sidebar mount с TanStack Router context + RBAC mock + cookie mock
- Active highlight tests: каждый из 8 active routes → `aria-current="page"` correct (8 tests)
- Nested-route active: `/admin/channels/:id` → parent NOT current (D22 guard) (4 tests)

### Playwright e2e (12 tests)

- `e2e/admin-sidebar-discoverability.spec.ts` — 10 destinations clickable from sidebar (10 tests)
- `e2e/admin-sidebar-keyboard.spec.ts` — Cmd+B toggle (1 test)
- `e2e/admin-sidebar-mobile.spec.ts` — offcanvas open/close + dismiss button focusable (1 test) — guards D12

### axe matrix (12 cells)

| Viewport \ Theme | Light | Dark | High-contrast |
|---|---|---|---|
| 320 (mobile offcanvas closed) | ✓ | ✓ | ✓ |
| 768 (mobile offcanvas open) | ✓ | ✓ | ✓ |
| 1024 (desktop sidebar default) | ✓ | ✓ | ✓ |
| 1440 (desktop sidebar collapsed icon) | ✓ | ✓ | ✓ |

**Required:** zero violations WCAG 2.2 AA per `project_axe_a11y_gate.md`.

### Visual smoke (4 viewports × Lost-Pixel или Playwright snapshot)

- 320/768/1024/1440 — sidebar default state
- Diff threshold: 0.5% (canonical M9.widget.6 setup)

---

## §9. Pre-done audit checklist (paste-and-fill template per sub-phase)

Каждый sub-phase commit body содержит:

```
## Pre-done audit checklist (A.bis.<N>)

### Cross-tenant × every method
- [ ] AdminSidebar читает useCurrentOrg().slug — verified не leak'ает orgs из cache
- [ ] RBAC predicates evaluated per-org (мульти-tenant пользователь со sessions A и B)
- [ ] SidebarProvider cookie не shared cross-org (cookie path scoped к orgSlug? document)

### PK-separation × N dimensions
- [ ] N/A (sidebar = pure frontend, no DB writes)

### Enum FULL coverage
- [ ] 3 roles × 10 sections = 30 visibility cases tested exactly (NOT >=)
- [ ] collapsible="icon" + "offcanvas" + "none" — all 3 variants smoke-tested

### Null-patch vs undefined-patch
- [ ] N/A

### UNIQUE collision per index
- [ ] N/A

### Gotchas applied
- [ ] D12 dismiss button focusable in mobile offcanvas — Playwright tab-loop spec passes
- [ ] D13 NEVER controlled `open` prop — eslint rule OR runtime assertion
- [ ] D14 single SidebarProvider — dependency-cruiser rule? OR doc'd canon
- [ ] D15 aria-label Cyrillic on every SidebarMenuButton — axe SR name check
- [ ] D16 forced-colors: ButtonText border — Playwright forced-colors spec passes
- [ ] D17 lg: breakpoint (NOT md:) — verified в Tailwind classes
- [ ] D20 cookie best-effort — documented в `_app.tsx` comment
- [ ] D22 activeOptions exact:true для parent groups — verified nested route doesn't double-current

### 9-gate green
- [ ] sherif ✓ — monorepo dep consistency
- [ ] biome ✓ — lint+format
- [ ] depcruise ✓ — no circular + no banned imports
- [ ] knip ✓ — no unused exports (mobile-nav* deleted? confirm)
- [ ] typecheck ✓
- [ ] build ✓ — vite production
- [ ] test:fast ✓ — frontend tests pass
- [ ] smoke ✓ — HTTP smoke against running app
- [ ] e2e:smoke + axe ✓ — Playwright + axe AA matrix

### Empirical
- [ ] pnpm dev в browser — visual diff vs baseline screenshots
- [ ] keyboard tour Cmd+B + arrow + tab — works as APG canonical
- [ ] curl против running backend — 0 regressions

### Memory
- [ ] Updated `project_a_bis_progress.md` — current state per sub-phase
- [ ] Process corrections captured (если есть)
```

---

## §10. RBAC matrix × sidebar (verified против `packages/shared/src/rbac.ts` 2026-05-12)

**7 active sections only** (per `feedback_no_halfway.md` — no vapor links). RBAC predicates empirically verified против `packages/shared/src/rbac.ts` full-read 2026-05-12 (143 lines):

| Section | Path | owner | manager | staff | RBAC predicate |
|---|---|---|---|---|---|
| Шахматка | `/o/:slug/grid` | ✓ | ✓ | ✓ | `hasPermission(role, { booking: ['read'] })` |
| Дебиторка | `/o/:slug/receivables` | ✓ | ✓ | ✗ | `hasPermission(role, { report: ['read'] })` (verify в implementation если staff должен видеть aging-screen) |
| Профиль гостиницы | `/o/:slug/properties/{firstId}/content` | ✓ | ✓ | ✗ | `hasPermission(role, { compliance: ['read'] }) \|\| hasPermission(role, { amenity: ['read'] })` (existing index.tsx:44-46 pattern) |
| Гости (МВД-картотека) | `/o/:slug/admin/migration-registrations` | ✓ | ✓ | ✓ | `hasPermission(role, { migrationRegistration: ['read'] })` — staff granted per rbac.ts:116 |
| Каналы дистрибуции | `/o/:slug/admin/channels` | ✓ | ✓ | ✗ | `hasPermission(role, { report: ['read'] })` |
| Туристический налог | `/o/:slug/admin/tax` | ✓ | ✓ | ✗ | `hasPermission(role, { report: ['read'] })` |
| Уведомления | `/o/:slug/admin/notifications` | ✓ | ✓ | ✗ | `hasPermission(role, { notification: ['read'] })` — staff NOT granted per rbac.ts:107 |

**RBAC по факту существующих resources** — `settings` resource НЕТ (verified rbac.ts:34-118 full read). Когда landing Settings sub-phase: ADD `settings: ['read', 'manage']` к owner в `rbac.ts` (`billing: ['manage']` reserve для billing-specific). Это **отдельный sub-phase commit**, не в A.bis.

**Strict tests:** 3 roles × 7 sections = 21 visibility assertions (exact-value, NOT >=). Cumulative `test-fast`-level. Enum FULL coverage per `feedback_strict_tests.md`.

**Staff sees 3 of 10 sections.** Owner sees 10. Manager sees 9 (no Settings).

Disabled-future sections (Бронирования, Тарифы, Платежи, Активность, Настройки) render visible с `<Badge>скоро</Badge>` для visible roadmap discoverability, но `aria-disabled="true"` + не clickable.

---

## §11. i18n / RU labels canon (single source `sidebar-sections.ts`)

**7 active sections** (no vapor) — empirically верифицированы против existing route tree 2026-05-12:

```ts
export const SIDEBAR_SECTIONS = [
  { id: 'grid', labelRu: 'Шахматка', ariaLabelRu: 'Шахматка — занятость номеров', icon: CalendarRange, path: '/o/$orgSlug/grid', permission: { booking: ['read'] } },
  { id: 'receivables', labelRu: 'Дебиторка', ariaLabelRu: 'Открытые счета с положительным балансом', icon: Wallet, path: '/o/$orgSlug/receivables', permission: { report: ['read'] } },
  { id: 'profile', labelRu: 'Профиль гостиницы', ariaLabelRu: 'Compliance, удобства, фото, описание', icon: Building2, path: '/o/$orgSlug/properties/$propertyId/content', permission: { compliance: ['read'] } /* OR amenity:read — runtime check */ },
  { id: 'guests', labelRu: 'Гости', ariaLabelRu: 'Картотека гостей и миграционный учёт МВД', icon: Users, path: '/o/$orgSlug/admin/migration-registrations', permission: { migrationRegistration: ['read'] } },
  { id: 'channels', labelRu: 'Каналы дистрибуции', ariaLabelRu: 'TravelLine, Яндекс.Путешествия, Ostrovok — статус подключений', icon: Network, path: '/o/$orgSlug/admin/channels', permission: { report: ['read'] } },
  { id: 'tax', labelRu: 'Туристический налог', ariaLabelRu: 'Квартальный отчёт по туристическому налогу 2% Сочи', icon: FileSpreadsheet, path: '/o/$orgSlug/admin/tax', permission: { report: ['read'] } },
  { id: 'notifications', labelRu: 'Уведомления', ariaLabelRu: 'История писем гостям и администрации', icon: Bell, path: '/o/$orgSlug/admin/notifications', permission: { notification: ['read'] } },
] as const
```

**i18n status (empirically verified 2026-05-12):** `@lingui/react ^6.0.0` (NOT v5 as in memory `project_m5_tech_decisions.md`) wired через `main.tsx:1 I18nProvider` + `features/i18n/setup.ts:21 i18n.activate(DEFAULT_LOCALE)`, но **ZERO `<Trans>` usages** в frontend src (`grep -rE "<Trans" apps/frontend/src` → empty). Lingui = unused infrastructure. **Acceptable hardcode**, consistent с rest of admin. **Obligation в memory**: separate i18n migration track для всего admin (deferred, не A.bis scope per `feedback_no_halfway.md` — не делать partial i18n на одной странице).

**Memory drift fix**: update `project_m5_tech_decisions.md` — Lingui v6, not v5 (A.bis.5 closure task).

---

## §12. A11y canon

- **APG Disclosure Hybrid pattern** для sub-menu nesting (Каналы → TL/YT/ETG). `aria-expanded` на parent button, panel = nav `<ul>` (NOT `role="menu"`).
- **`aria-current="page"`** auto-emit через TanStack `<Link>` + `activeProps={{ 'aria-current': 'page' }}` + `activeOptions={{ exact: true }}` для parent group (D22).
- **`aria-label` explicit Cyrillic** на каждом `<SidebarMenuButton>` (D15, R3 D-5).
- **focus-trap on mobile offcanvas** — Radix Dialog (Sheet base) reuse focus-trap.
- **dismiss button focusable** в mobile offcanvas (D12 — local patch против Issue #6761).
- **forced-colors mode** — `border-[ButtonText]` для collapsed icon buttons (D16).
- **Cmd+B keyboard toggle** — shadcn default, не переопределяем.
- **Skip link** «Перейти к содержимому» — `<a href="#main-content">` в `_app.tsx` ABOVE SidebarProvider для skip-nav WCAG 2.4.1 (already exists? verify в A.bis.2).

---

## §13. Migration plan (Vaul → 3 actual paths) — **POST-AUDIT corrected (was 5 paths v1)**

**POST-AUDIT insight (§0 recon):** `ui/responsive-sheet.tsx` УЖЕ bifurcates desktop/mobile через `useMediaQuery`. Consumers через ResponsiveSheet (consent-block / refund-sheet / migration-detail) получают **transparent migration** когда меняется underlying `drawer.tsx` impl. Only **direct Drawer consumers** + `drawer.tsx` itself нуждаются в коде. Plus widget vs admin split simplified.

**5 текущих Vaul consumer'а** (self-audit iteration 3 поймал 2 пропущенных через `ResponsiveSheet`):

| Consumer | Old (Vaul) | New | Sub-phase |
|---|---|---|---|
| `apps/frontend/src/components/sidebar-drawer.tsx` | Vaul Drawer для admin More-menu | **DELETE** entirely — заменяется `<Sidebar collapsible="offcanvas">` | A.bis.2 |
| `apps/frontend/src/features/admin-migration-registrations/components/migration-registration-detail-sheet.tsx` | Использует `ResponsiveSheet` (→ Drawer wrapper) для detail sheet | После split: `ResponsiveSheet` admin path → Radix Sheet. **Импорт не меняется** — refactor скрыт в wrapper | A.bis.0 |
| `apps/frontend/src/features/folios/components/refund-sheet.tsx` (**self-audit A3 catch**) | Использует `ResponsiveSheetTitle` через `ResponsiveSheet` | Аналогично — admin path → Radix Sheet. Импорт не меняется. | A.bis.0 |
| `apps/frontend/src/features/public-widget/components/sticky-summary.tsx` | Vaul Drawer для guest mobile summary | **Base UI Drawer** (`ui/widget-drawer.tsx`) — `swipeDirection="down"` + `snapPoints` — preserves drag-to-dismiss UX гостей. | A.bis.0 |
| `apps/frontend/src/features/public-widget/components/consent-block.tsx` (**self-audit A3 catch**) | Использует `ResponsiveSheet` (Trigger/Content/Header/Title/Description) для consent texts modal | Widget path → **Base UI Drawer** wrapper (`ResponsiveSheet` widget variant). Drag-to-dismiss preserves guest UX. | A.bis.0 |
| `apps/frontend/src/components/ui/drawer.tsx` (wrapper) | shadcn-canonical Vaul wrapper | **DELETE** after all 5 consumer'ов мигрировали | A.bis.0 closure |
| `apps/frontend/src/components/ui/responsive-sheet.tsx` (uses drawer.tsx) | Already bifurcates desktop Sheet/mobile Drawer | **NO CHANGE** (per §0 recon — existing useMediaQuery split works). Underlying `drawer.tsx` impl change propagates transparently. **POST-AUDIT correction v1 «SPLIT в 2 wrapper'а» был не нужен.** | A.bis.0 |

**Empirical-verify gap** для Base UI Drawer в widget context — widget использует Lit Web Component + Shadow DOM (apps/widget-embed). Base UI Drawer Shadow DOM compat НЕ verified в R1+R2+R3 — этот sticky-summary в **SPA путь** (`apps/frontend`), не embed-bundle. Embed widget не использует Vaul direct — SPA renders inside iframe fallback. So **scope ограничен SPA path**, Shadow DOM не concern для A.bis.

---

## §14. Risks / honest gaps

1. **shadcn sidebar Issue #6761 NOT fixed upstream** — мы owner copy после CLI add. Patch применяется сами (D12). Risk: при будущем `shadcn upgrade` наш patch может откатиться → process correction: **document patch в `ui/sidebar.tsx` header comment** + grep-able marker `// PATCH-D12 shadcn-ui#6761` для conflict detection.
2. **Base UI Drawer Shadow DOM** — НЕ verified в Lit context. SPA path safe (widget sticky-summary в SPA, не embed). НО future widget redesign может потребовать Drawer внутри Lit Shadow DOM → verify в момент.
3. **cmdk dormant** — defer A.bis.6 принят. Если RU power-users требуют Cmd+K раньше — native `<dialog>+<datalist>` fallback (~150 LOC) спасает.
4. **Cookie best-effort** (Safari ITP) — sidebar collapsed state может «забываться» после 7 дней. UX accepted: «expanded по умолчанию after long idle». Документировать в onboarding doc.
5. **Test count overhead** — 102+ strict tests это много, но соответствует production-grade canon (M9.widget.6 117 strict). Не overengineering.
6. **package.json diff 8 mutations** в одном commit — A.bis.0 — может вызвать peer-deps churn. Mitigation: `pnpm install --frozen-lockfile=false` сразу + smoke `pnpm dev` сразу + откат-план через `git checkout HEAD~1 -- pnpm-lock.yaml + apps/frontend/package.json`.
7. **TanStack `<Link>` activeOptions edge cases** для nested routes (D22) — может потребовать ad-hoc patches для конкретных paths (e.g., `/admin/channels` parent vs `/admin/channels/:id` child). Verify в A.bis.2 implementation + capture в process correction.
8. **D17 breakpoint domain override** — `md:` (768px) instead of R2 generic `lg:` (1024px) — deliberate choice для PMS front-desk tablet UX. Risk: дальнейший рост контента в sidebar может make 768px cramped. Mitigation: collapsible="icon" mode даёт 64px rail; user может collapse'ить вручную.
9. **Lingui v5→v6 memory drift** — `project_m5_tech_decisions.md` нужно обновить (A.bis.5 closure task f). Lingui v6 wired but 0 `<Trans>` usage in code — i18n migration отдельная фаза.
10. **No automated test для R3 D-9 controlled-prop bug** — eslint custom rule complex. Mitigation: code review checklist + grep regex `<SidebarProvider open=` в pre-commit hook (`grep -r "<SidebarProvider open" apps/frontend/src/ && echo "FAIL: use defaultOpen" && exit 1`).

---

## §15. DoD (Definition of Done for A.bis closure)

- [ ] vaul удалён из `package.json` + lockfile + node_modules
- [ ] Все 3 Vaul consumer'а мигрированы (sidebar-drawer DELETED, migration-detail-sheet → Radix Sheet, sticky-summary → Base UI Drawer)
- [ ] shadcn sidebar primitive в `ui/sidebar.tsx` с 5 локальными patches (D12-D16) — каждый patch с grep-able marker
- [ ] `<SidebarProvider>` в `_app.tsx` оборачивает Outlet
- [ ] `AdminSidebar` рендерится с 10 sections — RBAC × 3 roles × 10 = 30 visibility assertions passed
- [ ] Каналы продаж + МВД discoverable через sidebar (NOT только через URL) — verified Playwright spec
- [ ] Dashboard refactor done — index.tsx tiles → in-content KPI cards
- [ ] axe matrix 12 cells green — WCAG 2.2 AA
- [ ] Playwright e2e 12 specs green
- [ ] Visual smoke 4 viewports — pixel diff ≤ 0.5%
- [ ] forced-colors spec green
- [ ] 9-gate pre-push green: sherif + biome + depcruise + knip + typecheck + build + test:fast + smoke + e2e:smoke
- [ ] Pre-done audit checklist в каждом sub-phase commit body
- [ ] Memory updated: `project_a_bis_done.md`
- [ ] ROADMAP.md update: Track A.bis row marked ✅ + Track A→B sequencing reframed

---

## §16. Process corrections from R3 + R4 empirical (cumulative)

| # | Correction | Source | Applied in |
|---|---|---|---|
| C1 | shadcn sidebar Issue #6761 → ship dismiss button patch ourselves (PR #6798 closed unmerged 2026-03-07) | R3 D-1 + R4 web-verify | D12 |
| C2 | Radix Dialog 1.1.15 NOT 9mo stale (R3 wrong) → actually Dec 2025 (4.5mo), fine | R4 npm-verify | §5 |
| C3 | Base UI pkg name `@base-ui/react` NOT `@base-ui-components/react` (R3 wrong) | R4 web-verify + npm-verify | D6 |
| C4 | Base UI Drawer GA 1.4.1 — exists, swipeDirection works (R3 hypothetical confirmed) | R4 web-verify | D6 |
| C5 | TanStack auto-aria-current + activeOptions exact:true для parent groups | R3 D-4 | D22 |
| C6 | aria-label Cyrillic on every SidebarMenuButton (tooltip = secondary) | R3 D-5 | D15 |
| C7 | Sticky-summary widget → Base UI (NOT Radix), preserves drag-to-dismiss UX | R3 D-6 | §13 |
| C8 | pb-safe-bottom для все mobile Sheet/Drawer вариантов | R3 D-7 | (apply в A.bis.0 sheet/drawer wrappers) |
| C9 | Cookie ITP 2.3 → best-effort, не durable | R3 D-8 | D20 |
| C10 | NEVER controlled `open` prop в SidebarProvider — uncontrolled только | R3 D-9 | D13 |
| C11 | sidebar_state cookie NOT 152-ФЗ PII (boolean, no identifier) | R3 D-10 | D20 |
| C12 | RBAC × 10 sections (NOT 9) — Активность добавлено | R3 D-11 + D-14 | D28-D29 |
| C13 | Demo/Live badge в SidebarFooter | R3 D-12 | D31-D32 |
| C14 | OrgSwitcher в SidebarHeader (NOT top-bar) | R3 D-13 | D25 |
| C15 | Ladle stories + Lost-Pixel visual regression | R3 D-15 | §8 visual smoke (Lost-Pixel canonical) |
| C16 | forced-colors active → border-[ButtonText] | R3 D-16 | D16 |
| C17 | Single SidebarProvider только — document canon | R3 D-17 | D14 |
| C18 | tailwindcss ≥ 4.1 (container queries GA) — bump к 4.3.0 | R3 D-18 + R4 npm-verify | D8 |
| C19 | cmdk Cyrillic-broken → defer A.bis.6 (NOT staleness — Cyrillic ranking issue) | R3 D-3 + R4 npm-verify | D10 |
| C20 | cyrillic-to-translit-js 4yr stale → REJECT, написать 30-line custom если cmdk landing | R4 npm-verify | D10 |
| C21 | @nozbe/microfuzz 2yr stale но MIT works → DEFER к A.bis.6 | R4 npm-verify | D10 |
| C22 | Empirical-verify R3 perfectly — ловить hallucinations в research agents (canon-able process) | this session | (capture в feedback memory) |
| C23 | **Self-audit A1** — `settings` resource НЕ в rbac.ts → use `role === 'owner'` direct check для Settings row | self-audit iteration 3 | §10 |
| C24 | **Self-audit A2/A4** — breakpoint `md:` (NOT `lg:`) align с existing 17 project usages — front-desk на tablets видит sidebar | self-audit iteration 3 | D17 |
| C25 | **Self-audit A3** — 5 Vaul consumers, не 3 (пропустил `consent-block.tsx` + `refund-sheet.tsx` через `ResponsiveSheet`). `responsive-sheet.tsx` split в 2 wrapper'а (admin Radix vs widget BaseUI) | self-audit iteration 3 | §13 |
| C26 | **Self-audit A5** — `<SidebarTrigger>` explicit mount required (shadcn нет auto-hamburger). Minimal mobile-only top-bar с SidebarTrigger — top-bar НЕ удаляется полностью | self-audit iteration 3 | §6 architecture |
| C27 | `<SidebarMenuBadge>` shadcn primitive **существует** — для unread notifications count (R3 D-O3 satisfiable) | WebFetch shadcn docs | (capture в A.bis.2 notifications badge) |
| C28 | **8 canon violations** caught в 4-й self-audit pass (after user push «вспомни всё»): | self-audit iter 4 | applied всё ниже |
| C28.1 | 5 disabled-future sections = halfmeasure (`feedback_no_halfway.md`) | iter 4 | D28 (10→7 active) |
| C28.2 | cmdk DEFER к A.bis.6 = halfmeasure | iter 4 | D10 (OUT of scope) |
| C28.3 | `md:` align с legacy = anti-aggressive-delegacy | iter 4 | D17 (lg: + migrate 17 existing) |
| C28.4 | RU hardcoded labels — defer Lingui = consistent с rest of admin, но needs migration note | iter 4 | §11 (defer + memory obligation) |
| C28.5 | `role === 'owner'` RBAC bypass = anti-canon | iter 4 | D28 + §10 (Settings removed entirely, ADD `settings` resource когда settings page lands) |
| C28.6 | `project_locked_versions.md` not updated | iter 4 | A.bis.5 closure (d) |
| C28.7 | `project_architecture_decisions.md` not updated | iter 4 | A.bis.5 closure (e) |
| C28.8 | `pnpm outdated` phase-end audit missing (per `feedback_dependency_freshness.md`) | iter 4 | A.bis.5 closure (g) |
| C29 | **Empirical RBAC full-read** (per `feedback_no_shallow_frontend_audit.md`): `settings` resource confirmed missing; `billing` exists для owner; staff has `migrationRegistration:read` (rbac.ts:116), NOT `notification`; rbac.ts has 143 lines, не нужно скрытых resources | full-read rbac.ts 2026-05-12 | §10 verified |
| C30 | **Lingui drift**: memory `project_m5_tech_decisions.md` говорит v5, actual `@lingui/react ^6.0.0` + ZERO `<Trans>` usages. Memory update obligation | empirical grep | A.bis.5 closure (f) |
| C31 | **Mission link**: A.bis не закрывает напрямую функцию из 7×3 мандата — это **архитектурный foundation** разблокирующий будущие admin-страницы (rate-calendar/inventory/payments). Без A.bis каждая будущая admin-страница повторит channels-discoverability gap. Senior pragmatism: pre-deploy single architectural foundation > 5 ad-hoc tile additions | mission framing review (since beginning of our work) | §1 |
| **C32** | **POST-AUDIT 2026-05-12 (после b396ac0)** — empirical full-map ui/ folder + `radix-ui` subpath analysis surfaced **4 factual errors в v1 plan**: | empirical recon | new `feedback_pre_plan_codebase_recon.md` canon + §0 added |
| C32.1 | v1 D2-D5 «ADD `@radix-ui/react-{dialog,collapsible,tooltip,slot}`» — но `radix-ui` unified ^1.4.3 уже в deps, subpath imports cover all 4 primitives | npm view + grep | D2-D5 corrected |
| C32.2 | v1 §3 «Create `ui/sheet.tsx`» — но **уже существует** 147 lines Radix Dialog-based | wc -l + Read | §3 + §0 |
| C32.3 | v1 §13 «Split `ui/responsive-sheet.tsx`» — но **уже bifurcates** desktop/mobile через useMediaQuery | Read | §13 + §0 |
| C32.4 | v1 «8 package mutations» — реально **4** (1 DROP + 2 BUMP + 1 ADD `@base-ui/react`) | §0 recon | §5 + §7 A.bis.0 |
| C33 | **New canon** `feedback_pre_plan_codebase_recon.md` — mandatory §0 «Codebase state» в каждом plan canon ДО §1 Mission. Read all existing relevant files + grep deps + verify «create X» не существует. Predicts plan canon factual accuracy. | this session learning | new memory + MEMORY.md pointer |

---

## §17. Implementation log (per sub-phase R1+R2 freshness checks)

*Заполняется по мере landing каждой sub-phase.*

### A.bis.0 (Vaul migration prep) — pending

Pre-flight R1+R2 freshness check (≥2026-05-12):
- [ ] npm-verify Base UI 1.4.1 still GA
- [ ] npm-verify @radix-ui/react-dialog still 1.1.15 (или новее)
- [ ] Vaul status — still unmaintained? (sanity)

Outcome: TBD

### A.bis.1 (shadcn sidebar primitive) — pending

Pre-flight R1+R2 freshness check:
- [ ] shadcn issue #6761 — still open? (sanity)
- [ ] shadcn issue #8176 — still open?
- [ ] Latest shadcn sidebar source (CLI fetch) — diff против ожидаемого

Outcome: TBD

### A.bis.2 (App-shell integration) — pending

Pre-flight R1+R2 freshness check:
- [ ] TanStack Router `activeOptions` docs не изменились
- [ ] RBAC matrix `packages/shared/src/rbac.ts` не изменился

Outcome: TBD

### A.bis.3 (Dashboard refactor) — pending

Pre-flight R1+R2 freshness check:
- [ ] 2026 KPI cards canon (Cloudbeds/Mews/Linear pattern)

Outcome: TBD

### A.bis.4 (E2E + axe matrix + visual) — pending

Pre-flight R1+R2 freshness check:
- [ ] axe-core/playwright latest version verify
- [ ] Lost-Pixel или Playwright snapshot canonical

Outcome: TBD

### A.bis.5 (Closure) — pending

---

## Origin

Создано 2026-05-12 после **6 раундов аудита** frontend admin coverage:
- Раунд 1: 15 «gap'ов» по shallow find/grep
- Раунд 2: 11 после Explore agent (нашёл refund/payments/notifications)
- Раунд 3: 10 после чтения chessboard полностью
- Раунд 4: discoverability gap (но ложная тревога — mobile nav есть)
- Раунд 5: 6 gap'ов после `_app.tsx` + nav components
- **Раунд 6 финал: 3 P0 + 5 P1/P2** (после wizard-store + PassportScanDialog callers + booking-edit grep)

Один из 3 P0 (channels discoverability на desktop) — раскрыт как **симптом архитектурного gap'а: отсутствие proper app-shell для desktop**. Track A.bis закрывает архитектурно, разблокирует все будущие admin-страницы (rate calendar / inventory CRUD / etc.) одним foundation'ом.

**Senior process learnings:**
- `feedback_no_shallow_frontend_audit.md` — created during this session (file-level reading > find/grep)
- `feedback_research_strictness_today.md` — R1+R2+R3+R4 ≥2026-05-12 даты в prompts (fresh)
- `feedback_empirical_method.md` — R4 caught 3 R3 hallucinations через npm-curl + WebFetch direct verify

Process corrections (R3 catches surfaced 22+ items) добавлены в §16. Эта дисциплина повторяема в будущих sub-phase'ах.
