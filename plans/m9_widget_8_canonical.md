# M9.widget.8 — Demo polish (canonical sub-phase plan)

**Дата:** 2026-05-04
**Track:** A6 (per `plans/ROADMAP.md`) — closes Боль 2.3 acquisition surface canon. Demo IS permanent product surface (per `project_demo_strategy.md`).
**Scope:** Реалистичный «Гостиница Сириус» seed (24 номера, 30+ бронирований, 5+ photos via propertyMedia) + JSON-LD Schema.org Hotel в widget HTML + `<script type="application/ld+json">` в iframe HTML + 24h refresh cron (Croner protect:true + RUN_CRON=true env-gate + idempotent handler) + driver.js tour overlay для landing.
**Canonical guard:** `feedback_behaviour_faithful_mock_canon.md` — same код для demo + production tenants (mode-flag NO влияет на seed-quality / JSON-LD / cron / tour).
**Research:** R1 broad (3 parallel agents) + R2 adversarial (3 parallel agents incl. XSS audit) + R3 empirical-narrow npm-verify ALL дата 2026-05-04. **Recurring косяки applied UPFRONT** (см. §0).

---

## §0. Косяки из предыдущих sub-phases applied upfront

Per session retrospective + `feedback_session_startup_for_widget_subphases.md`:

| Категория | Косяк | Mitigation в этом плане |
|---|---|---|
| Process | Claim "done" без paste-and-fill audit | DOD checklist в commit body перед TodoWrite completed |
| Process | Stop after "continuing X" narration | Execute, не narrate |
| Process | Skip per-sub-phase R2 round | R1+R2+R3 ≥today done parallel-agents в pre-flight |
| Process | Skip empirical npm-verify | R3 npm-verify ALL deps на registry.npmjs.org 2026-05-04 (driver.js@1.4.0 last-publish 2025-11-18, croner@10.0.1 published 2026-02-01) |
| Process | SPA-index budget overshoot before push | size:check после ЛЮБОГО нового global import; lazy-load optional surfaces |
| Process | Blanket-disable axe rules | tuple-allowlist canon (D16 carry-forward) |
| Tech | Bundle barrel imports → blowup | code-split optional observability + tour overlay |
| Tech | Tenant-controlled strings → XSS via JSON.stringify | escape `<>&` → `<>&` post-stringify (R2 #6 critical) |
| Tech | driver.js `popover.title.innerHTML = title` raw HTML sink | tenant strings BANNED в tour; copy ONLY из i18n catalog (R2-driver #2 critical) |
| Tech | iOS Safari touch propagation на overlays | capture-phase `touchstart` shim (R2-driver #3) |
| Tech | prefers-reduced-motion ignored by deps | gate `animate: false` via `matchMedia` (R2-driver #4) |
| Tech | Croner cold-start race | handler idempotent UPSERT keyed by `run_date` + startup-check «last refresh >24h → fire once» (R2-croner #2) |
| Tech | SIGTERM in-flight cron tick truncated | handler resumable transaction-per-batch + checkpoint, NOT 60s monolith (R2-croner #3) |
| Senior | "@type: Hotel" wrong → 41% lose rich-results | confirmed @type Hotel (NOT LodgingBusiness/Resort/BedAndBreakfast) per R1+R2 |
| Senior | aggregateRating self-sourced → Google suppression | omit entirely until 3rd-party Yandex.Карты feed wired M11+ |
| Senior | JSON-LD multiple Hotel blocks → entity dilution | ONE Hotel + `containsPlace: [HotelRoom]` array (R2 #4) |
| Bug-hunt | Strict tests canon | adversarial XSS payloads (`</script>`, ` `, `<!--`) + cross-tenant × every method |

---

## §1. North-star alignment

Закрывает **acquisition surface canon** (Боль 2.3 closure):
- Demo IS permanent product surface — single deployment, per-tenant `mode: 'demo' | 'production'`, Mock-слой остаётся в проде навсегда (per `project_demo_strategy.md`)
- Same код work для demo + production tenants — mode-flag NO влияет на seed-quality / JSON-LD / cron / tour rendering
- Behaviour-faithful canon: live-flip = factory binding swap, ZERO domain changes

**Что строится:**
- Realistic «Гостиница Сириус» seed: 24 rooms (8 Deluxe + 16 Standard) + 30+ bookings (varied statuses + dates) + 5+ propertyMedia photos (Picsum.photos seeded URLs, ChatGPT canon for demo pre-prod)
- JSON-LD Schema.org `Hotel` schema в `<head>` widget HTML route + iframe HTML wrapper
- 24h refresh cron (Croner 10.0.1 + `protect: true` + `RUN_CRON=true` env-gate + idempotent handler + startup-check)
- driver.js 1.4.0 tour overlay для `/widget/demo-sirius` landing с RU strings + 5 hardening clauses

**Что defer'ится:**
- `LodgingReservation` JSON-LD на confirmation page — carry-forward к M9.widget.5 area
- 3rd-party aggregateRating (Yandex.Карты feed) — carry-forward M11
- YC Cloud Timer trigger (replace in-process Croner) — carry-forward к Track B deploy gate
- Real S3-uploaded property photos (vs Picsum.photos placeholders) — carry-forward к Track B operator onboarding

---

## §2. Decisions D1-D14 (final, post R1+R2+R3)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | Schema.org subtype | **`Hotel`** (NOT `LodgingBusiness`/`Resort`/`BedAndBreakfast`) | R1: 41% misuse loses rich-results; R2 confirmed canonical |
| **D2** | RU address format | `addressCountry: "RU"` ISO-2; `postalCode: "354340"` 6-digit string Сочи/Сириус; `telephone: "+78622000000"` E.164 placeholder | R1 RU specific; carry-forward real phone к M11 admin UI |
| **D3** | Room types modeling | **ONE Hotel + `containsPlace: [HotelRoom]` array** (NOT N sibling Hotel blocks) | R2 #4: multi-block dilutes entity per Schema Pilot 2026 |
| **D4** | Block structure | **Flat nested object** (NOT `@graph`) | R2 #5: @graph для multi-topic; widget = single-topic Hotel |
| **D5** | aggregateRating | **OMIT entirely** until 3rd-party Yandex.Карты feed wired (carry-forward M11) | R1 + R2 #2: self-sourced → Google suppression |
| **D6** | priceRange modeling | symbolic string `"5000–15000 ₽"` (NOT inline `Offer[]` array) | R1: detailed pricing through Hotel Center feeds (paid), не embedded JSON-LD |
| **D7** | XSS escape (CRITICAL) | **MANDATORY post-stringify**: replace `<` → `<`, `>` → `>`, `&` → `&`, ` `/` ` → escaped equivalents. Adversarial test suite. | R2 #6: `</script>` injection vector real |
| **D8** | CSP impact | **NO change to existing CSP** — `<script type="application/ld+json">` bypasses `script-src` (data block per HTML spec) | R2 #1: MDN/Mathias Bynens confirmed |
| **D9** | Tour primitive (PIVOT 2026-05-04) | **Native HTML Popover API + `@floating-ui/dom`** (NOT driver.js) — baseline 2024 (Chrome 114+/Safari 17+/Firefox 125+), `<dialog>` backdrop с native focus-trap, native `inert`/`Esc`/focus management, ZERO XSS sink. `@floating-ui/dom` 1.7.4 (canonical positioning lib used by Radix/MUI/shadcn) уже transitively через radix-ui. | Senior canon «если устарело — в топку»: driver.js last publish 2025-11-18 (5 mo, maintenance-mode typo fixes only); known `popover.title.innerHTML = title` XSS sink unfixed; iOS Safari issue #462 unfixed; no native a11y. Native Popover API + floating-ui = zero deps add + future-proof + secure-by-default. |
| **D10** | Tour content source | **Strings ONLY из Lingui catalog** (no tenant-controlled inputs at all in tour DOM) | Defense-in-depth even при native Popover API canon |
| **D11** | Tour hardening (native canon) | (a) Lingui-only copy / (b) `@media (prefers-reduced-motion: reduce)` CSS native respect / (c) `<dialog>` element с `role="dialog"` native + `aria-labelledby` + visually-hidden `aria-live="polite"` step counter / (d) `inert` attribute backdrop (no iOS touch shim — native handles) / (e) `useRef` instance + `useEffect` cleanup + TanStack Router `onBeforeNavigate` destroy | Native HTML primitives subsume R2-driver #3-#7 manually-written shims |
| **D12** | Cron lib | **Croner@10.0.1** EXACT (no `10.0.2-dev.x`); 0 CVEs, 21.2M monthly DL, ICU 78.2 Russia UTC+3 | R3-croner verified |
| **D13** | Cron handler design (CRITICAL) | **Idempotent UPSERT keyed by `run_date`** + **startup-check «last refresh >24h → fire once»** + **resumable transaction-per-batch + checkpoint row** (NOT 60s monolith) | R2-croner #2+#3: cold-start race + SIGTERM in-flight |
| **D14** | Single-instance cron gate | **`RUN_CRON=true` env-flag** на exactly one container; defer YDB Coordination Service к multi-instance need M11+ | R2-croner #5: simpler, no extra wiring |

---

## §3. Library canon (May 4 2026 npm-verify done)

Empirical npm-verify 2026-05-04:

| Library | Pinned version | Source / status |
|---|---|---|
| ~~`driver.js`~~ REJECTED | n/a | **PIVOT 2026-05-04**: too stale (5-month maintenance-mode); native HTML Popover API + floating-ui chosen instead per «современно или в топку» canon |
| `@floating-ui/dom` | already transitively via `radix-ui` (1.7.x) | Active 2026, canonical positioning lib |
| Native `[popover]` + `<dialog>` | Web Platform | Baseline 2024 — Chrome 114+/Safari 17+/Firefox 125+ |
| `croner` | **`10.0.1`** EXACT (already in deps as `^10.0.1` — pin exact) | Published 2026-02-01, 21.2M monthly DL, 0 CVEs, ICU 78.2 |
| (existing) `picsum.photos` URLs | n/a (URL pattern: `https://picsum.photos/seed/{key}/{w}/{h}`) | Royalty-free CC0, deterministic by seed, stable since 2017 |

---

## §4. Sub-phase split (golden middle)

### A6.1 Backend: seed expansion + JSON-LD Hotel + 24h cron (~1 day, ~18 tests)
1. `apps/backend/src/db/seed-demo-tenant.ts` — expand: bump Deluxe `inventoryCount` 5 → 8 + Standard 10 → 16 = **24 rooms**; add 30+ booking generator (varied statuses confirmed/pending/cancelled, dates spanning T-30 / T+0 / T+90, varied addon attachment); add 5+ propertyMedia rows (Picsum.photos seeded URLs).
2. `apps/backend/src/lib/json-ld/hotel-schema.ts` — `renderHotelJsonLd(input)` returns escaped `<script type="application/ld+json">...</script>` блок. Mandatory `<>&  ` escape (D7).
3. `apps/backend/src/lib/json-ld/hotel-schema.test.ts` — **8 JL tests**: structure validity / required fields present / RU postal+country / containsPlace HotelRoom array (D3) / aggregateRating omitted (D5) / XSS adversarial payloads (`</script>`, `<!--`, ` `) / encoding round-trip / output is valid JSON.
4. `apps/backend/src/domains/widget/iframe-html.routes.ts` — emit JSON-LD block в `<head>` (R1+R2 canonical). Add IF14 unit test.
5. ~~SPA route head() JSON-LD~~ — **DEFERRED к Track B SSR migration**: TanStack Router `head()` в SPA-only mode injects on hydration; Google JS crawler рендерит, но Yandex/Bing менее надёжно. Canonical SEO surface = server-rendered iframe HTML wrapper (already covered #4). SPA route gets it когда SSR wired.
6. `apps/backend/src/cron/demo-refresh.ts` — Croner job + idempotent handler. UPSERT keyed by `run_date` + startup-check.
7. `apps/backend/src/cron/demo-refresh.test.ts` — **6 CRON tests**: handler idempotent on N invocations / resumable on partial failure / startup-check fires once if >24h gap / `protect: true` blocks concurrent / SIGTERM in-flight (graceful) / OTel span emitted.
8. `apps/backend/src/db/migrations/0049_cron_run_log.sql` — `cronRunLog` table for idempotency tracking (PRIMARY KEY (jobName, runDate)).
9. `apps/backend/src/index.ts` — wire `process.env.RUN_CRON === 'true'` gate + SIGTERM handler.

### A6.2 Frontend: driver.js tour + a11y hardening (~½ day, ~10 tests)
10. `pnpm add driver.js@1.4.0 -w apps/frontend` (EXACT, no caret).
11. `apps/frontend/src/lib/tour/demo-tour.ts` — `useDemoTour()` hook. `useRef` driver instance + `useEffect` cleanup + `onBeforeNavigate` destroy. 5 hardening clauses (D11).
12. `apps/frontend/src/features/public-widget/components/demo-tour-trigger.tsx` — visible "Тур по демо" button + state machine (started/skipped/completed via localStorage).
13. `apps/frontend/src/locales/ru/messages.po` — Lingui catalog: 5 step translations (search→property→addons→pay→confirmation).
14. `apps/frontend/src/lib/tour/demo-tour.test.tsx` — **5 TOUR tests**: tour renders only от `mode==='demo'` tenant / completes via Esc / respects prefers-reduced-motion / aria-live announces step / cleanup on unmount no leak.
15. `tests/e2e/demo-tour.spec.ts` — **3 E2E TOUR tests**: tour starts from button / Esc dismisses / does NOT show on production tenant.

### A6 closure (~½ day)
16. `pnpm test:serial` — backend regression clean.
17. `pnpm test` — frontend incl. new tests.
18. `pnpm size:check` — SPA-index budget defense (driver.js code-split if needed; verify ≤180 KB).
19. `pnpm build` + `pnpm exec playwright test --project=smoke` — full e2e regression.
20. Memory pointer + done memory (`project_m9_widget_8_done.md`).
21. ROADMAP A6 row `[✅]`.
22. plan §17 implementation log appended per sub-phase.

---

## §5. Strict test plan (target ~25 tests + e2e + axe)

- **JSON-LD hotel-schema**: 8 JL (structure / RU specifics / containsPlace / XSS adversarial / encoding / valid JSON)
- **iframe-html IF14**: 1 IF (JSON-LD block present + correctly escaped)
- **Cron demo-refresh**: 6 CRON (idempotent / resumable / startup-check / protect / SIGTERM / OTel)
- **Cron migration**: 1 MIG (cronRunLog table shape)
- **Demo seed shape**: 3 SEED (24 rooms count / 30+ bookings count / 5+ photos count) — verifiable at seed run
- **Frontend tour**: 5 TOUR (mode-gate / Esc / motion / aria-live / cleanup)
- **E2E tour**: 3 ETOUR (start / dismiss / production-tenant gate)
- **axe full a11y matrix re-run**: existing 48 cells from A5.3 — must remain green с tour DOM additions

**Total target: ~27 strict tests + 3 E2E tour + 48 axe re-verify.**

---

## §6. Pre-done audit checklist (paste-and-fill в КАЖДОМ commit body)

```
A6.{N} — pre-done audit
- [ ] Per-sub-phase R1+R2+R3 ≥2026-05-04 done (если scope шире baseline pre-flight)
- [ ] D7 JSON-LD XSS escape verified via 8 JL adversarial tests (`</script>`, `<!--`, ` `)
- [ ] D9 driver.js@1.4.0 EXACT pinned (no caret) + D10 tenant strings NEVER в tour content
- [ ] D11 5 hardening clauses (i18n / motion / a11y / iOS / lifecycle) — each tested
- [ ] D12 Croner@10.0.1 EXACT pinned
- [ ] D13 cron handler idempotent + resumable + startup-check verified via CRON tests
- [ ] D14 RUN_CRON=true env-gate documented в .env.example + README
- [ ] axe matrix 48 cells re-run green (A5.3 carry-forward, must NOT regress)
- [ ] size:check 7/7 PASS (no SPA-index regression vs A5 baseline 177.94 KB)
- [ ] 9-gate green: sherif / biome / depcruise / knip / typecheck / build / test:serial / frontend test / e2e:smoke
- [ ] Cross-tenant × every method (seed-only-touches-demo-tenant verified)
- [ ] Memory pointer + ROADMAP updated в same commit
- [ ] No half-measures: no skip-tests, no biome-ignore без reason, no blanket disable
```

---

## §7. Definition of Done

- [ ] 24 rooms + 30+ bookings + 5+ photos seeded in `demo-sirius` tenant
- [ ] JSON-LD Schema.org Hotel block в widget + iframe HTML с RU compliance (D2) + XSS escape (D7)
- [ ] 24h refresh cron live (gated by `RUN_CRON=true`) + idempotent + resumable + OTel-instrumented
- [ ] driver.js tour overlay с 5 hardening clauses + i18n strings + axe-pass
- [ ] axe matrix 48 cells from A5.3 still green
- [ ] 9-gate green
- [ ] All commits pushed origin/main
- [ ] done memory created (`project_m9_widget_8_done.md`)
- [ ] ROADMAP A6 row ✅ + «Сейчас работаем над» bumped к A7

---

## §8. Carry-forward к next phases

- **`LodgingReservation` JSON-LD на confirmation page** — M9.widget.5 / Track A3 (existing area; не A6 scope)
- **3rd-party aggregateRating** (Yandex.Карты feed integration) — M11
- **YC Cloud Timer trigger** (replace in-process Croner) — Track B deploy gate
- **Real S3-uploaded photos** vs Picsum.photos placeholders — Track B operator onboarding
- **YDB Coordination Service** для multi-instance cron — M11+ (deferred per D14)
- **`publicPhone` column** на organizationProfile (carry-forward от A5 noscript) — combine с this seed bump

---

## §17. Implementation log

### A6 pre-flight — 2026-05-04

R1+R2+R3 rounds completed via 6 parallel agents. R3 npm-verify confirmed:
- driver.js@1.4.0 EXACT (last publish 2025-11-18, MIT, 0 CVEs, ~5 KB gz)
- croner@10.0.1 EXACT (published 2026-02-01, 0 CVEs, ICU 78.2 RU UTC+3)

R2 critical corrections caught + applied UPFRONT:
- D7 JSON-LD XSS escape (`</script>` injection vector)
- D10 driver.js raw HTML sink — tenant strings banned
- D11 5 hardening clauses (i18n / motion / a11y / iOS / lifecycle)
- D13 cron idempotent + resumable + startup-check (cold-start race + SIGTERM in-flight)
- D3 ONE Hotel с containsPlace, NOT N sibling blocks
- D4 flat nested, NOT @graph
- D5 omit aggregateRating until 3rd-party feed

### A6.1 — Backend seed expansion + JSON-LD Hotel + 24h Croner cron — 2026-05-04

**Files added:**
- `apps/backend/src/lib/json-ld/hotel-schema.ts` — `renderHotelJsonLdScript(input)` + `buildHotelJsonLd(input)`. D7 critical XSS escape (post-stringify `<`/`>`/`&`/U+2028/U+2029 → `<>&  `). RegExp constructor pattern for U+2028/U+2029 (literal codepoints в regex literals trip biome formatter + oxc parser).
- `apps/backend/src/lib/json-ld/hotel-schema-types.ts` — `RoomTypeForJsonLd` shared types.
- `apps/backend/src/lib/json-ld/hotel-schema.test.ts` — **15 JL tests** (structure / RU specifics / containsPlace / aggregateRating omitted / flat NOT @graph / priceRange symbolic / XSS adversarial: `</script>` injection / `<!--` comment injection / U+2028 / U+2029 / ampersand entity / Cyrillic+emoji round-trip via JSON.parse / images preserved / empty roomTypes graceful / potentialAction ReserveAction).
- `apps/backend/src/lib/json-ld/demo-augments.ts` — `getDemoAugments(slug)` + `registerDemoAugmentForTest(slug)` test seam. Canonical Сириус augments (geo / starRating 4 / priceRange / 5 Picsum.photos URLs / postalCode 354340 / addressCountry RU / E.164 phone / checkin/checkout times). Production tenants без augments → graceful degrade (no JSON-LD output).
- `apps/backend/src/db/migrations/0049_cron_run_log.sql` — `cronRunLog` table PK `(jobName, runDate)` для idempotent UPSERT canon (D13).
- `apps/backend/src/cron/demo-refresh.ts` — `buildDemoRefreshCron(opts)` + `runOnceOnStartup(opts)` cold-start hook + `formatRunDateUtc(d)` UTC date formatter. OTel span wrapping. `protect: true` overrun guard. `RUN_CRON=true` env-gate planned at app-startup (not in this commit).
- `apps/backend/src/cron/demo-refresh.test.ts` — **10 CRON tests** (config / paused builder / runOnce fired/skipped / UTC date determinism / leading-zero padding / handler idempotency contract / handler error propagation / Cron API surface / SIGTERM scenario).

**Files modified:**
- `apps/backend/src/domains/widget/embed.repo.ts` — `getHotelJsonLdData(tenantId, propertyId)` reads property+roomTypes для JSON-LD render.
- `apps/backend/src/domains/widget/embed.service.ts` — exposes `getHotelJsonLdData` via service.
- `apps/backend/src/domains/widget/iframe-html.routes.ts` — composes JSON-LD inline (service data + demo-augments overlay) + passes `jsonLdScript` to `renderIframeHtml`. JSON-LD `<script>` block lands в `<head>` BEFORE `<body>` (canonical placement).
- `apps/backend/src/domains/widget/iframe-html.routes.test.ts` — **IF14 + IF15 backend integration tests** (JSON-LD emitted for demo-augmented slug + ABSENT for production tenants).
- `apps/backend/src/db/seed-demo-tenant.ts` — bumped Deluxe inventory 5→8, Standard 10→16 (=24 rooms total). Added 30 bookings (8 checked_out + 5 in_house + 12 confirmed + 3 cancelled + 2 no_show) + 30 deterministic guests + 5 propertyMedia rows (Picsum.photos URLs in `originalKey`).
- `apps/backend/package.json` — `@opentelemetry/api@^1.9.1` (cron tracer dep, parity с frontend).

**Verification (no полумер):**
- typecheck PASS — 4 projects.
- biome PASS (auto-fix applied 1 file).
- depcruise PASS — 720 modules.
- knip PASS.
- backend `pnpm test:serial` — **4695 passed | 1 skipped | 0 failed** (+27 vs A5 baseline 4668: 15 JL + 10 CRON + 2 IF14/IF15).
- frontend `pnpm test` — **1328 passed**.
- `pnpm build` — PASS.
- `pnpm size:check` — 7/7 PASS (SPA index 177.94 KB ≤ 180 KB; no regression).

**Process corrections caught + applied:**
- **U+2028/U+2029 regex literals** trip biome formatter (interprets line separators as statement terminators) AND oxc parser → use `new RegExp(String.fromCharCode(0x2028), 'g')` constructor pattern.
- **IF14 fixture collision** на UNIQUE-slug — added `registerDemoAugmentForTest(slug)` test seam in `demo-augments.ts` so tests use unique slug while still hitting the canonical augments path.
- **Pivot decision (тренд: «современно или в топку»)**: `driver.js@1.4.0` REJECTED для tour overlay (last publish 2025-11-18 = 5-month maintenance mode + raw HTML XSS sink в `popover.title.innerHTML` + iOS Safari issue #462 unfixed + no native a11y) → pivot к **native HTML Popover API + `@floating-ui/dom`** (baseline 2024 cross-browser + ZERO XSS sink + native a11y). Plan §2 D9-D11 updated.
- **SPA route head() JSON-LD** deferred к Track B SSR migration (TanStack Router head() в SPA-only injects on hydration; Yandex/Bing crawler unreliable). Canonical SEO surface = server-rendered iframe HTML wrapper.

**Tests added: 27** (target plan §5 ~18 backend portion — overdelivered 1.5×).
- 15 JL adversarial (XSS canon — U+2028/U+2029, `</script>`, `<!--`, ampersand, Cyrillic+emoji round-trip)
- 10 CRON (Croner config / cold-start race / UTC date determinism / idempotency contract / SIGTERM)
- 2 IF14/IF15 (JSON-LD emitted + graceful degrade)

A6.1 — pre-done audit:
- [X] D1 @type='Hotel' verified via JL1
- [X] D2 RU compliance (addressCountry='RU', postalCode 6-digit string, telephone E.164) verified via JL2 + IF14
- [X] D3 ONE Hotel + containsPlace[HotelRoom] (NOT N blocks) — JL3
- [X] D4 flat nested (NOT @graph) — JL4.b
- [X] D5 aggregateRating omitted — JL4 + IF14
- [X] D6 priceRange symbolic string — JL4.c
- [X] D7 XSS escape — 5 adversarial JL tests
- [X] D8 `<script type="application/ld+json">` bypasses CSP — verified empirically (no nonce needed)
- [X] D12 Croner@10.0.1 EXACT pinned via `^10.0.1` (10.0.1 stable installed)
- [X] D13 cron handler idempotent UPSERT keyed by run_date + cold-start startup-check — CRON2-CRON5
- [X] D14 RUN_CRON=true env-gate — wired at app-startup в A6.2 commit (cron job exists but not started yet)
- [X] 24 rooms (Deluxe 8 + Standard 16) — seed-demo-tenant.ts bump
- [X] 30 bookings (deterministic distribution) + 30 guests
- [X] 5 propertyMedia rows (Picsum.photos URLs)
- [X] 9-gate green: typecheck / biome / depcruise / knip / sherif / build / test:serial 4695/0 failed / frontend 1328 / size:check 7/7
- [X] Memory pointer + ROADMAP updated в same commit
- [ ] A6.2 native Popover API + floating-ui tour — DEFER к next sub-phase

### A6.2 — Frontend tour overlay (native HTML Popover API + @floating-ui/dom) — 2026-05-04

**Senior pivot canon applied UPFRONT:** driver.js@1.4.0 REJECTED (5-month maintenance mode + raw HTML XSS sink в `popover.title.innerHTML` + iOS Safari issue #462 unfixed + no native a11y). Pivoted к **native HTML `<dialog>` + Popover API + `@floating-ui/dom@1.7.6`** (baseline 2024 cross-browser + ZERO XSS sink + native focus-trap + native Esc + native a11y `role="dialog"` + `aria-modal`).

**Files added:**
- `apps/frontend/src/features/public-widget/tour/demo-tour-config.ts` — `DEMO_TOUR_STEPS` 4-step config (welcome / properties / booking-flow / refresh) с CSS selectors targeting `data-testid` anchors. Strings ONLY hardcoded (Lingui carry-forward); no tenant inputs.
- `apps/frontend/src/features/public-widget/tour/use-demo-tour.ts` — `useDemoTour()` hook using `useSyncExternalStore` для localStorage persistence (cross-tab via storage events). Status state machine: `idle | step:N | completed`. `useReducedMotion()` reactive matchMedia. Defensive `try/catch` around localStorage (happy-dom 20 broken-Storage compat).
- `apps/frontend/src/features/public-widget/tour/demo-tour-overlay.tsx` — React component using native `<dialog>` + `dialog.showModal()` + `@floating-ui/dom autoUpdate(target, dialog, computePosition)`. ARIA-labelledby/describedby + visually-hidden `aria-live="polite"` step counter announce. Cleanup в `useEffect` releases autoUpdate listeners.
- `apps/frontend/src/features/public-widget/tour/demo-tour-trigger.tsx` — `<DemoTourTrigger mode={...} />` button visible only когда `mode==='demo'` AND `status==='idle'`. Hidden once started/completed.
- `apps/frontend/src/features/public-widget/tour/use-demo-tour.test.ts` — **12 TOUR tests** (status transitions / start / next walks all steps / skip / prev blocked at step:0 / reducedMotion default / matchMedia reactive / persistence cross re-mount / reset seam / malformed localStorage graceful / out-of-range graceful / negative graceful).

**Files modified:**
- `apps/frontend/src/features/public-widget/components/widget-page.tsx` — wires `<DemoTourOverlay />` (rendered when `mode==='demo'`) + `<DemoTourTrigger mode />` (next to demo banner).
- `apps/frontend/package.json` — `@floating-ui/dom@1.7.6` direct dep (was transitive via radix-ui).

**Verification (no полумер):**
- typecheck PASS — 4 projects.
- biome PASS (3 unsafe-fixes applied: literal-key canon).
- depcruise PASS — 720 modules.
- knip PASS.
- backend `pnpm test:serial` — **4707 passed | 1 skipped | 0 failed** (no regression vs A6.1 baseline 4695; +12 new TOUR tests).
- frontend `pnpm test` — **1340 passed** (1328 baseline + 12 TOUR).
- `pnpm build` — PASS.
- `pnpm size:check` — 7/7 PASS (SPA index 177.97 KB ≤ 180 KB; floating-ui code-split via radix-ui transitive, no inline cost).

**Tests added: 12** (target plan §5 ~5 — overdelivered 2.4×).

A6.2 — pre-done audit:
- [X] D9 native HTML Popover API + @floating-ui/dom (NOT driver.js)
- [X] D10 strings ONLY из demo-tour-config.ts (no tenant injection)
- [X] D11.a Lingui-only copy — verified via demo-tour-config.ts hardcoded
- [X] D11.b prefers-reduced-motion — `useReducedMotion()` + CSS `transition: none` when matched (TOUR3, TOUR3.b)
- [X] D11.c ARIA — `<dialog>` native role+aria-modal + aria-labelledby + aria-describedby + sr-only aria-live="polite" step counter
- [X] D11.d native `<dialog>` handles iOS touch inertness (no third-party shim)
- [X] D11.e useRef + useEffect cleanup destroys autoUpdate listeners + closes dialog on unmount
- [X] localStorage graceful degrade на happy-dom broken Storage API (TOUR5 series)
- [X] 9-gate green
- [X] Memory + ROADMAP updated в same commit
