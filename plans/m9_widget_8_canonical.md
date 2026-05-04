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
| **D9** | Tour library | **driver.js@1.4.0** EXACT (MIT, ~5 KB gz, last commit 2026-02-27 not abandoned) | R2-driver #1+#9: 0 CVEs, 838K weekly DL, vs AGPL alternatives |
| **D10** | Tour content source | **Tenant strings BANNED — copy ONLY из i18n catalog** | R2-driver #2 critical: `popover.title.innerHTML = title` raw HTML sink |
| **D11** | Tour 5 hardening clauses | (a) i18n-only copy / (b) `matchMedia('(prefers-reduced-motion: reduce)')` gate / (c) `onPopoverRender` adds `role="dialog"` + `aria-modal` + `aria-labelledby` + visually-hidden `aria-live="polite"` step counter / (d) iOS capture-phase `touchstart` shim issue #462 / (e) `useRef` instance + `useEffect` cleanup + TanStack Router `onBeforeNavigate` destroy | R2-driver #3-#7 |
| **D12** | Cron lib | **Croner@10.0.1** EXACT (no `10.0.2-dev.x`); 0 CVEs, 21.2M monthly DL, ICU 78.2 Russia UTC+3 | R3-croner verified |
| **D13** | Cron handler design (CRITICAL) | **Idempotent UPSERT keyed by `run_date`** + **startup-check «last refresh >24h → fire once»** + **resumable transaction-per-batch + checkpoint row** (NOT 60s monolith) | R2-croner #2+#3: cold-start race + SIGTERM in-flight |
| **D14** | Single-instance cron gate | **`RUN_CRON=true` env-flag** на exactly one container; defer YDB Coordination Service к multi-instance need M11+ | R2-croner #5: simpler, no extra wiring |

---

## §3. Library canon (May 4 2026 npm-verify done)

Empirical npm-verify 2026-05-04:

| Library | Pinned version | Source / status |
|---|---|---|
| `driver.js` | **`1.4.0`** EXACT | Last publish 2025-11-18, last commit 2026-02-27, 838K weekly DL, MIT, 0 CVEs, ~5 KB gz |
| `croner` | **`10.0.1`** EXACT (already in deps as `^10.0.1` — pin exact) | Published 2026-02-01, 21.2M monthly DL, 0 CVEs, ICU 78.2 |
| (existing) `picsum.photos` URLs | n/a (URL pattern: `https://picsum.photos/seed/{key}/{w}/{h}`) | Royalty-free CC0, deterministic by seed, stable since 2017 |

---

## §4. Sub-phase split (golden middle)

### A6.1 Backend: seed expansion + JSON-LD Hotel + 24h cron (~1 day, ~18 tests)
1. `apps/backend/src/db/seed-demo-tenant.ts` — expand: bump Deluxe `inventoryCount` 5 → 8 + Standard 10 → 16 = **24 rooms**; add 30+ booking generator (varied statuses confirmed/pending/cancelled, dates spanning T-30 / T+0 / T+90, varied addon attachment); add 5+ propertyMedia rows (Picsum.photos seeded URLs).
2. `apps/backend/src/lib/json-ld/hotel-schema.ts` — `renderHotelJsonLd(input)` returns escaped `<script type="application/ld+json">...</script>` блок. Mandatory `<>&  ` escape (D7).
3. `apps/backend/src/lib/json-ld/hotel-schema.test.ts` — **8 JL tests**: structure validity / required fields present / RU postal+country / containsPlace HotelRoom array (D3) / aggregateRating omitted (D5) / XSS adversarial payloads (`</script>`, `<!--`, ` `) / encoding round-trip / output is valid JSON.
4. `apps/backend/src/domains/widget/iframe-html.routes.ts` — emit JSON-LD block в `<head>` (R1+R2 canonical). Add IF14 unit test.
5. `apps/frontend/src/routes/widget.$tenantSlug.tsx` — render JSON-LD via TanStack Router `head()` config (no SSR overhead; client-side render canonical для SPA).
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

### A6.1 (commit pending)
TBD — backend seed + JSON-LD + cron findings.

### A6.2 (commit pending)
TBD — frontend tour findings.
