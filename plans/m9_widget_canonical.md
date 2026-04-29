# M9.widget — Public Booking Widget + Payments (canonical)

**Дата:** 2026-04-29
**Источник:** 6 раундов web-research (2026-04-29) + research-cache cross-check (`plans/research/public-widget-ux.md` 2026-04-27) + npm-empirical-verify всех новых deps + grep-проверка `apps/backend/src/` + `apps/frontend/src/`. 6 hallucination'ов в research-cache пойманы и исправлены (см. §12).
**Confidence:** High (UX 3-screen canon + ЮKassa Checkout Widget v1 SAQ-A + Lit 3.3.2 Web Component + Declarative Shadow DOM + iframe fallback). Medium (точные thresholds ПП №1912 + 152-ФЗ 2025-09-01 wording — требует empirical legal verify perd launch). Low (Yandex Auto Alice booking-along-route — strategic, не в M9.widget сразу).
**Aesthetic motto:** «современный + строгость + простота» (наследуется от M9 theming) — Linear/Stripe ethos. Booking widget = first guest impression → critical mobile-first + INP ≤200ms + zero dark patterns.
**Запуск:** ПОСЛЕ M9 (theming/adaptive) — ✅ closed 2026-04-29 commit `e5fb3d3`. Empirical-batch Track 1 ✅ closed 2026-04-29 (turnkey scripts ready). M9.widget — следующая major фаза, **строится на Stub-ЮKassa + Mock external integrations** с empirical-verification disclaimer.

---

## §1. Стратегический фрейм

**Что закрываем:** Боль 2 функция 2.3 — публичный виджет онлайн-бронирования с платежами. После M9.widget closure: **6/7 функций end-to-end закрыто** (остаётся 2.2 Channel Manager → M10). Always-on demo получает реальный booking flow вместо placeholder.

**End-state pain-mapping:**
- Сочи отель (5-50 номеров) встраивает виджет на свой сайт через `<script>` snippet или iframe link
- Гость бронирует напрямую → отель не платит 17% OTA-комиссии (Booking/Ostrovok/Я.Путешествия) и +60% revenue per booking (per Skift 2026 baseline)
- Мобильный flow first-class, в т.ч. iOS 26 «Open as Web App» Add to Home Screen (M9.4 PWA уже даёт)
- Passkey checkout (M9.5 Phase D уже даёт инфраструктуру) — 73% быстрее (8.5s vs 31.2s passwords) с 93% success rate
- Voice/AI booking via Yandex Auto + Alice (M+later strategic) — Сочи на конце трассы M4 Дон, road-trip traffic relevant

**Не покрываем (out-of-scope для этой фазы):**
- Yandex Auto Alice skill для голосового booking — стратегический differentiator, отдельная фаза M+later
- Multi-room booking (Apaleo поддерживает, Bnovo нет) — defer M+later
- Group bookings (>5 номеров) — обычно contact-form, не self-serve
- Loyalty program / member rates — defer M+later
- AI Trip Planner / conversational booking (Hilton +17% revenue lift baseline) — strategic, defer M11+
- Rate parity check vs Yandex.Travel — compliance/legal больше чем UX
- Real-time "X people viewing now" indicator — нужен realtime channel, не M9.widget
- Offline booking sync (PWA offline-first) — defer demo-фазе

**Aesthetic North Star (наследие M9 theming):** «современный + строгость + простота» = Linear/Vercel/Stripe ethos. NO Liquid Glass `backdrop-blur`, NO playful animations, NO multi-accent palette cycle. ONE Sochi-blue brand, neutral OKLCH base, modular typography (1.250 ratio), tonal dark elevation. **Booking widget = trust surface** — guest принимает решение платить нам деньги, минимизируем визуальный шум.

**Production-grade с первой строчки:** demo с пустым виджетом = embarrassing для новых клиентов. Hostaway Booking Site Pro ($49/mo, 2026 launch) и SiteMinder Little Hotelier (Feb 2026 relaunch, target <30-room properties) — **прямые конкуренты в нашей нише**. Меньше чем у них = заведомо проиграли.

**Direct-booking value prop усилился в 2026Q1:** Yandex.Travel поднял базовую комиссию с 15% до **17% с 2026-02-01** ([logos-pres.md 2026 verified](https://logos-pres.md/en/news/major-hotel-chains-refused-to-work-with-yandex/)) — Azimut/Accor/Cosmos/Mantera в знак протеста сняли ~50k номеров с агрегатора. Наш виджет даёт отелям save 17% commission + +60% revenue per booking (Skift baseline 2026). Эта regulatory pressure в нашу пользу.

**RU-first canon:** widget строится для RU primary, EN secondary (~10-15% inbound Сочи). 152-ФЗ separate-document consent (2025-09-01), ПП РФ №1912 от 2025-11-27 (cancellation rules), 38-ФЗ ст. 18 marketing opt-in, КСР registry mandatory display, туристический налог 2% Сочи 2026. Yandex Cloud only (per `feedback_yandex_cloud_only.md`) — никаких Cloudflare Workers для edge (RU-restricted).

---

## §2. Senior-level commitments (8 решений, не вопросы)

| № | Решение | Reasoning |
|---|---|---|
| 1 | **Embed-tech: Lit 3.3.2 Web Component + Declarative Shadow DOM SSR + iframe fallback (для strict-CSP hosts)** | Wave 2 Luzmo benchmark: Web Components ~4-5× faster than iframe load. Declarative Shadow DOM Newly Available 2024-08-05, Widely Available 2026-08-20 (Baseline). research-cache claim "Apaleo Shadow DOM script-injection canon" NOT verified — Apaleo actual = API-first + третьи виджеты (Simultem/DIRS21/myIBE). Mews loader builds iframe under hood. Booking.com affiliate = iframe. Lit 3.3.2 (Dec 2025) + DSD = модернее всех existing vendors на 2026-04. **Bundle target: ≤30 kB gzip initial loader** (Mews ~11 kB baseline). |
| 2 | **Payment: ЮKassa Checkout Widget v1 (iframe → SAQ-A scope) для card+СБП+MirPay+SberPay+T-Pay** | Wave 5 verified: 3 distinct ЮKassa products. **Checkout Widget v1** (`yookassa.ru/checkout-widget/v1/checkout-widget.js`) = ready-made iframe form, single embed handles all RU mobile pay rails, PCI scope = SAQ-A (22 reqs не 191 SAQ-A-EP). NSPK universal QR mandatory Sept 1 2026 — поддержка через ЮKassa Widget автоматически. **REJECT: ЮKassa Checkout.js v1 (tokenization library)** — попадаем в SAQ-A-EP с 191 reqs. **REJECT: T-Bank Acquiring Widget standalone** — Wave 5 URL 404'd, не canonical 2026. ЮKassa остаётся primary. |
| 3 | **Magic-link booking management (signed JWT, 7-day view + 15-min mutate TTL, per-tenant secret)** | Research-cache §11.4 + memory `project_postbox_domain_pending.md`. Гость получает email с magic-link → JWT verify → set HttpOnly cookie + invalidate JWT on first click → access guest portal (view + cancel). НЕ требует password / signup. Booking reference в URL **недостаточен** для access — нужен JWT. Reference + email fallback с rate-limit (10 req/min IP, 5 req/hour email, 3 req/hour reference) + Yandex SmartCaptcha invisible после 3 fails. |
| 4 | **3-screen flow: Search&Pick / Extras / Guest+Pay (не 4-step, не single-page)** | Cache canon + Baymard 2024 still primary 2026 (Wave 4: no fresh 2026 hotel-specific Baymard update). Apaleo IBE v2 (2024 redesign) + Mews + Cloudbeds IE 2.0 (Q2 2026 cutover) — все 3-screen. 5-step имеет cliff abandonment между steps; single-page Stripe-style overwhelms на mobile (>3000px scroll). 3 = sweet spot. |
| 5 | **Pre-selected default room/rate (choice architecture canon 2026 — Wave 4 +82% adoption)** | Suebehaviouraldesign 2026 baseline: 82% выбирают pre-selected default. >5 options = decision fatigue. Default highlight: BAR-flex для гибкости (free cancel deadline visible) — гость видит безопасный выбор первым, может down-grade на BAR-NR за -15% если ОК с risk. |
| 6 | **Mobile-first canon: bottom-sheet rate picker via Vaul (M9.5 lock 1.1.2) + sticky CTA + above-fold availability search (Hostaway 2026 pattern)** | Wave 1: Hostaway Booking Site Pro 2026 — mobile-first **availability search + booking CTA above-fold**. SiteMinder Little Hotelier Feb 2026 target <30-room — direct ICP overlap, изучаем их паттерны. Vaul уже в стеке после M9.5 — переиспользуем. Touch targets 44×44 (WCAG 2.5.5 AAA де-факто 2026 baseline). |
| 7 | **Always-on demo seeder polish: realistic Сочи tenant с widget surface + 7×3 features visible** | Per `project_demo_strategy.md` + `project_initial_framing.md` reframe: demo IS permanent product surface. Demo tenant получает 5-7 номеров (Deluxe Sea View + Standard Mountain View + Family Suite + Apartment 2BR), 3 rate plans (BAR Flex / BAR NR / Long-stay -25%), realistic photos (placeholder Unsplash CC0 для Сочи), сезонная цена (winter / summer split), 14-day forward bookings (varied statuses) для chessboard demo. **JSON-LD structured data + `hotel-info.json`** (Wave 1 Mews 2026 strategic insight: AI agents will discover hotels via machine-readable content). |
| 8 | **Performance budget hard gate: Bundle ≤30 kB gzip initial / LCP ≤2.5s / INP ≤200ms / CLS ≤0.1 at p75** | Wave 6: SchedulingKit 2026 industry standard ≤30 kB gzip initial. CWV 2026 thresholds unchanged from 2024 (LCP+INP Baseline Newly available 2025-12-12). Pre-push gate: Lighthouse CI `@lhci/cli` 0.15.x checks all 4 budgets per sub-phase commit. |

---

## §3. Stack — verified empirically (npm view 2026-04-29 EXACT after senior sanity-check pass)

```
ADD (новые deps в M9.widget — ALL versions empirically locked 2026-04-29):
  lit                            3.3.2   (Web Component framework, published 2025-12-23 — verified npm 2026-04-29)
  @lit-labs/ssr                  4.0.0   (Declarative Shadow DOM SSR, published 2025-12-23 — was approximation, NOW LOCKED)
  @lhci/cli                      0.15.1  (canonical LHCI CI pair 2026; pins lighthouse@12.6.1 internally — Lighthouse 13.1.0 GA but LHCI ecosystem not yet updated; canonical pair like vitest+coverage-v8)
  jose                           6.2.3   (JWT signing/verify, published 2026-04-27 — was 5.10.x in draft, MAJOR VERSION JUMP 5→6 caught в self-audit Iteration 6; universal runtime support Node/Browser/Cloudflare/Deno/Bun)
  ics                            3.12.0  (booking confirmation .ics attachment, published 2026-04-23 — exact, не approximation)

ALREADY in stack — reuse без version change:
  vaul                           1.1.2 ✓ (M9.5 lock — bottom-sheet rate picker mobile)
  web-vitals                     5.2.0 ✓ (M9.6 lock — INP/LCP/CLS publishing)
  motion                         12.38.0 ✓ (subtle micro-interactions; reducedMotion="user" уже в main.tsx)
  React                          19.2.5 ✓ (selective hydration via useTransition/useDeferredValue)
  TanStack Router                1.168.25 ✓ (новые public routes под /widget/* + /book/*)
  TanStack Query                 5.100.6 ✓ (availability + rate fetching с staleTime 30s)
  TanStack Form                  1.29.1 ✓ (3-screen flow guest form — ≤7-field rule per `feedback_form_pattern_rule.md`)
  date-fns                       4.1.0 ✓ (booking dates, ru-RU formatting)
  react-day-picker               9.14.0 ✓ (range picker — 2-month desktop, single-month mobile)
  Lingui                         6.0.0 ✓ (RU/EN i18n)
  Tailwind                       4.2.4 ✓ + tailwind-merge 3.5.0
  radix-ui                       1.4.3 ✓ (Dialog/Popover/Sheet primitives)
  zod                            4.3.6 ✓ (booking form schema validation)
  hono                           4.12.15 ✓ (public booking routes — no auth)
  @aws-sdk/client-s3             3.1038.0 ✓ (room photo presigned-GET serving)
  @better-auth/passkey           1.6.9 ✓ (passkey checkout reuse от M9.5 Phase D)
  Yandex SmartCaptcha            v2 (CDN-only, не npm) — invisible mode для submit booking guard

EXTERNAL (CDN, не npm):
  ЮKassa Checkout Widget v1      yookassa.ru/checkout-widget/v1/checkout-widget.js (verified 2026-04-29)
  Yandex Metrika                 mc.yandex.ru/metrika/tag.js (under nonce CSP)
  Yandex SmartCaptcha            captcha.yandex.com/widget?hl=ru (invisible mode)
```

### Hallucination'ы пойманные на этом этапе (фиксирую честно — будет добавлено в §12)

1. **research-cache `public-widget-ux.md` line 347**: «Apaleo Booking Engine (canonical 2026): script injection с Shadow DOM» — **NOT verified в 2026 sources** (Wave 2). Apaleo actual = API-first; widget сторонние (Simultem/DIRS21/myIBE — Apaleo Store partners). Шаблон `<script src="https://booking.apaleo.com/v2/embed.js">` в cache — likely fabricated/inferred URL без empirical confirmation. **Action:** наш canon = Lit 3.3.2 Web Component + Declarative Shadow DOM SSR (2026 Baseline 2024-08-05) + iframe fallback, НЕ "Apaleo-style".

2. **research-cache line 354**: «Mews Distributor: full-page redirect или iframe» — partially correct, но **более точно 2026**: Mews script loader `<script src="..."></script>` builds iframe under-hood (Wave 2 docs.mews.com). UX в iframe = single-page-with-payment, но embed mechanism = iframe.

3. **memory `project_north_star_canonical.md` line 135** (до моих edit'ов сегодня): "M9 (next) — Боль 2.3 booking widget + theming/adaptive parallel session" — bundle widget+theming в M9. **Actualized 2026-04-29**: M9 = только theming/adaptive (closed `e5fb3d3`), widget = M9.widget separate phase.

4. **memory `project_app_scaffold.md` line 154** (до edit): «❌ M9 — Public booking widget» — outdated после M9 closure. **Actualized 2026-04-29**: M9 closed без widget; M9.widget = next.

5. **research-cache §11.5 hallucination**: цитирует "Apaleo Pre-stay developer guide" как source для notification timing — **partially correct** но не canonical для booking widget specifically. Notification timing = 2-event (T−3d pre-arrival + arrival_day) per `notifications-references.md` (2026-04-27).

6. **Wave 4 Mews "Copilot" agentic narrative — НЕ SKU**: research-cache references «Mews Copilot» (через memory `project_mcp_server_strategic.md` цитируя 2026-03-26 launch). Wave 4 Mews website 2026-04 НЕ имеет Copilot product page — то, что мы наблюдали, было agentic/marketing narrative ("Mews 2035 outlook"), фактический продукт = **Mews BI** (analytics, not booking widget). **Action:** memory note будет обновлён в `project_mcp_server_strategic.md` после M9.widget canon (out-of-scope для этой фазы — strategic context-fix, не блокер canon).

---

## §4. NOT to add (REJECT с reasoning)

| Что | Почему reject |
|---|---|
| **ЮKassa Checkout.js v1 tokenization library** | SAQ-A-EP scope = 191 PCI reqs vs SAQ-A 22 reqs. Custom card form = forms host script integrity monitoring (PCI 6.4.3 + 11.6.1). Для small HoReCa overhead огромный. Choose ready-made Widget v1 iframe → SAQ-A. |
| **CloudFlare Workers / Pages для edge** | RU-geopolitically-restricted (per `feedback_yandex_cloud_only.md`). Cloudflare acquired Astro 2026-01-16 — но это всё equally Cloudflare-locked = не для нас. Stay Yandex Cloud Functions / Yandex Cloud CDN. |
| **React Server Components для embed** | Anti-pattern для 3rd-party HTML — server boundary в чужом DOM не работает. Wave 6 explicit: «RSC for embed = anti-pattern». Используем Streaming SSR shell + CSR islands. |
| **Qwik 2.0 для виджета** | Adoption 4-7% 2026, niche. Lit 3.3.2 + Declarative Shadow DOM = более mainstream + better-supported для Web Component pattern. Risks: fewer libraries, fewer docs RU. |
| **Astro Server Islands для widget host** | Astro acquired by Cloudflare 2026-01-16 → non-РФ-friendly trajectory. Server Islands отлично работают для SSG/SSR, но booking widget = full-CSR after initial hydration. Plain Vite 8 + React 19 = canonical. |
| **scheduler.yield() / scheduler.postTask()** | Wave 6: NOT Baseline (no Safari implementation 2026Q2). Используем feature-detect fallback → `setTimeout(0)` или `await new Promise(r => MessageChannel)`. |
| **Apple Pay / Google Pay в payment widget** | Non-functional в РФ с 2022 (Visa/MC suspension). Wave 5: ApplePay/GooglePay убраны из ЮKassa. Используем MirPay/SberPay/T-Pay/СБП через ЮKassa Widget (single-embed handles all). |
| **Yandex Pay button** | Sanctioned 2026 (per [OpenSanctions Yandex Pay](https://www.opensanctions.org/entities/ca-sema-4a1e19737e79870d087f16df466c1f8879078c64/) verified 2026-04-29). Никогда не был в ЮKassa Widget enum — НЕ опция. Стратегически: Yandex Travel в проблемах (commission hike + chain withdrawals 2026), нашему widget'у НЕ нужна Yandex Pay интеграция. |
| **Lighthouse 13.1.0 standalone (без LHCI)** | GA published, Node 22.19+ требование (наш Node 24+ OK). НО `@lhci/cli@0.15.1` pins `lighthouse@12.6.1` exact internally — для CI используем canonical LHCI pair. Когда LHCI 0.16+ обновится с Lighthouse 13 — bump пакетной парой. Это «lagging но canonical», НЕ stale. |
| **`<input type="number">` для guest stepper** | Wave 7.4: на iOS показывает спинщики, на Android — текст. Используем buttons + visible number с aria-live="polite". |
| **Soft-Navigation INP (2026 OT)** | Chrome 147 origin trial March 2026 — НЕ Baseline, no CrUX integration на 2026Q2. Wait until full release ≥H1 2027. |
| **Hopper-style price prediction** | Hopper monetises 100% of planners vs OTA-scale inventory. Не применимо для small HoReCa без inventory volume. Skip. |
| **Booking.com Genius blanket 10% / Hilton AI Trip Planner** | OTA-scale features (millions of guests, ML pipelines). Hilton +17% lift = data point, не блюпринт для SMB Сочи. Pre-selected default room (Wave 4: 82% adoption) — applicable, no AI required. |
| **Apaleo MCP / "Hospitable MCP" для guest-facing widget** | Per `project_mcp_server_strategic.md` MCP — strategic differentiator на admin-facing AI agent. Guest-facing AI booking — defer M11+ если decisively выигрываем. |
| **Astro 6.0 beta** | beta-6 in flight, не stable. Stay на Vite 8 + React 19 + Lit 3.3.2 — все Baseline-stable. |
| **Apaleo IBE v2 / Mews Distributor / Cloudbeds IE 2.0 OEM как embed** | Не наш бизнес — мы строим первоклассный native widget. Конкурируем UX качеством, не интегрируем чужие виджеты. |
| **Custom 3D card flip animation на success** | Шум. Linear/Stripe canon: subtle micro-interaction (success icon scale-in 150ms + tabular-nums booking ref reveal), нет 3D wow-эффектов. |
| **`aria-live="assertive"` на live availability changes** | Spam screen reader. Use `aria-live="polite"` или `role="status"` per WCAG 2.2. |

---

## §5. Sub-phases — пошагово

### M9.widget.0 — Pre-flight (0.5 дня)

**Explicit empirical commands (executed 2026-04-29 baseline, re-run before M9.widget.1 start):**

```bash
# 1. Grep baseline gaps
grep -rE "features/widget|features/public-widget|features/payment-flow" apps/frontend/src/
# expected: 0 occurrences (clean slate)

grep -rE "/widget/\$|/book/\$|public.routes" apps/frontend/src/routes/ apps/backend/src/
# expected: 0 occurrences

grep -rE "magicLink|magic_link|signedJwt" apps/backend/src/ apps/frontend/src/
# expected: 0 occurrences (новый module)

grep -rE "smartcaptcha|SmartCaptcha" apps/frontend/src/ apps/backend/src/
# expected: 0 occurrences (новый dep)

grep -rE "checkout-widget\|yoo-checkout\|@a2seven" apps/
# expected: 0 occurrences (REST direct canon per project_yookassa_canon_corrections.md)

# 2. NPM verify all 5 new deps (re-check для drift защиты)
npm view lit@3.3.2 @lit-labs/ssr @lhci/cli jose ics version dist-tags
# expected: all match canonical from §3

# 3. Baseline test:serial green (no pre-existing fails per feedback_no_preexisting.md)
pnpm test:serial   # expected: 3767+ pass

# 4. Baseline e2e green
pnpm test:e2e:smoke   # expected: 79+ green

# 5. CWV baseline на текущих pages (для regression detection после M9.widget)
pnpm exec lhci autorun --collect.url=http://localhost:5173/login --collect.url=http://localhost:5173/signup
# expected: LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 на текущих anonymous routes

# 6. Bundle baseline (для tracking ≤30kB embed canon)
du -sh apps/frontend/dist/assets/*.js | sort -h | head -5
# expected: текущий main bundle ~xxx KB — note для regression
```

**Definition of Done M9.widget.0:**
- [ ] Все 6 grep checks executed → output logged в `M9_WIDGET_BASELINE.md` (working note, gitignored)
- [ ] `npm view` 5 deps — versions match canonical (drift = update §3 stack section + commit lock file refresh)
- [ ] `pnpm test:serial` all green (no pre-existing fails)
- [ ] `pnpm test:e2e:smoke` all green
- [ ] CWV baseline снят, p75 violations zero
- [ ] M9 closed (verified `git log --oneline -3` shows M9 done через `e5fb3d3`)

**Commit pattern:** `chore(plans): M9.widget.0 — pre-flight baseline verification` (если есть changes; иначе skip)

---

### M9.widget.1 — Public hosted route + tenant subdomain (~2 дня)

**Цель:** новый public hosted виджет на routes `/widget/{tenantSlug}` (preview) + production tenant подключение через `book.{tenant}.ru` subdomain (configurable).

**Files to add:**
- `apps/backend/src/domains/widget/public.routes.ts` — public Hono routes, NO auth, NO tenant middleware (resolve tenant from URL slug):
  - `GET /api/public/widget/:tenantSlug/properties` — list properties для Sochi tenant
  - `GET /api/public/widget/:tenantSlug/properties/:propertyId/availability?from=&to=&adults=&children=` — availability + rates
  - `GET /api/public/widget/:tenantSlug/properties/:propertyId/photos` — presigned-GET URLs
- `apps/backend/src/domains/widget/widget.repo.ts` — read-only DB access, only published content (filter `isPublic=true`)
- `apps/backend/src/domains/widget/widget.service.ts` — orchestration (rate calculation, availability merge с booking lock)
- `apps/backend/src/lib/tenant-resolver.ts` — resolve `tenantSlug` → `tenantId` (case-insensitive, ASCII)
- `apps/frontend/src/routes/widget.$tenantSlug.tsx` — public route без `_app` prefix (no auth gate)
- `apps/frontend/src/features/public-widget/` — feature directory (далее sub-screens)
- `apps/frontend/src/features/public-widget/lib/widget-api.ts` — typed API client с TanStack Query

**Files to modify:**
- `apps/backend/src/app.ts` — mount `widgetRoutes` BEFORE auth middleware:
  ```ts
  app.route('/api/public/widget', widgetRoutes)  // PUBLIC — no auth
  app.use('*', authMiddleware())  // existing, applies to non-public routes
  ```
- `apps/frontend/src/routes/__root.tsx` — handle `/widget/*` route без auth redirect
- CORS allow-list: extend `cors()` middleware с `allowOrigins` для tenant-supplied embed origins (per-tenant config). For M9.widget.1 — public routes accept `Origin: *` для read endpoints (availability/photos). Mutating endpoints (POST booking) — require explicit allow-list per tenant (М9.widget.4 concern).
- `apps/backend/src/db/seed-demo-tenant.ts` — extend с realistic Сочи property content (5-7 rooms + 3 rate plans + 14-day availability + photo placeholders)

**Strict tests (target ~30):**
- `widget.routes.test.ts` — public access без auth (no 401), tenant slug case-insensitivity, unknown tenant → 404, rate-limit per IP (10 req/min на read endpoints)
- `widget.repo.test.ts` — `isPublic=true` filter (cross-tenant isolation regression — публичный route не утечёт private property)
- `widget.service.test.ts` — availability merge с booking lock (overlapping booking → not available), rate calculation с multi-night discount + tourism tax 2%
- `tenant-resolver.test.ts` — slug normalization, ASCII validation, reject malformed
- `widget.$tenantSlug.tsx` route — Playwright smoke (anonymous can load), axe-pass (WCAG 2.2 AA)

**axe-gate:** новые routes (`/widget/{slug}`) добавляются в e2e axe matrix → 9 pages × 2 themes = 18 axe scans

**CSP**: для public routes устанавливаем строгий CSP header через middleware:
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{nonce}' https://yookassa.ru https://mc.yandex.ru https://yastatic.net https://captcha.yandex.com 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://*.storage.yandexcloud.net https://mc.yandex.ru;
  frame-src https://yookassa.ru https://captcha.yandex.com;
  connect-src 'self' https://mc.yandex.ru;
  frame-ancestors 'self' {tenant-allowed-origins};
  require-trusted-types-for 'script';
```
Trusted Types = Chromium-only stable, FF/Safari gated 2026 — header добавляется как progressive enhancement (graceful degrade).

**Definition of Done M9.widget.1:**
- [ ] Public hosted route `/widget/{slug}` рендерится anonymous user
- [ ] Backend routes return realistic data для demo tenant (5-7 rooms + photos + availability)
- [ ] CORS allow-list per-tenant configured (read endpoints `*`, mutating restricted)
- [ ] CSP strict header применяется через middleware
- [ ] Cross-tenant isolation tests green (no `isPublic=false` leakage)
- [ ] axe-pass на новой public route (light + dark + mobile + contrast-more = 4 scans)
- [ ] Lighthouse: LCP ≤2.5s + CLS ≤0.1 на initial load анонимным юзером

**Commit pattern:** `feat(m9.widget.1): public hosted route + tenant resolver + CSP strict + cross-tenant isolation`

---

### M9.widget.2 — Screen 1 (Search & Pick) (~3 дня)

**Cycle:** 3-screen flow, screen 1 = search dates + guests + promo + rate selection. Hostaway 2026 canon: **availability search + booking CTA above-fold** на mobile.

**Files to add:**
- `apps/frontend/src/features/public-widget/screens/search-and-pick.tsx`
- `apps/frontend/src/features/public-widget/components/date-range-picker.tsx` — `react-day-picker 9.14.0` ru-RU + 2-month desktop / single-month mobile via `useMediaQuery`
- `apps/frontend/src/features/public-widget/components/guest-selector.tsx` — stepper inside Popover panel (Adults/Children/Infants/Pets + children ages если children > 0)
- `apps/frontend/src/features/public-widget/components/rate-card.tsx` — vertical room card с inline rate options (BAR Flex / BAR NR), photo carousel (lazy-load кроме first)
- `apps/frontend/src/features/public-widget/components/sticky-summary.tsx` — desktop right-sticky / mobile bottom-fixed via Vaul
- `apps/frontend/src/features/public-widget/components/photo-gallery.tsx` — lightbox per room, AVIF→WebP→JPEG `<picture>` fallback
- `apps/frontend/src/features/public-widget/lib/widget-store.ts` — Zustand store с persist (localStorage TTL 30min, key `widget-{tenantSlug}`) + URL state sync (dates + room + rate в query params)
- `apps/frontend/src/features/public-widget/hooks/use-availability.ts` — TanStack Query c staleTime 30s (per cache §3.4 "stale availability refetch перед commit")

**Files to modify:**
- `widget-api.ts` — add availability + photos query types + Zod schemas

**Strict tests (target ~50):**
- `date-range-picker.test.tsx` — range select, min stay restrictions visible перед клик, disabled dates с tooltip, ARIA APG combobox+grid pattern, keyboard navigation
- `guest-selector.test.tsx` — stepper increment/decrement bounds (max adults=4, total=6, pets=2 per room.maxOccupancy), children require age picker
- `rate-card.test.tsx` — photo lazy-load (only first eager), AVIF fallback chain, choice architecture (default highlight на BAR Flex)
- `sticky-summary.test.tsx` — pricing breakdown (subtotal + tax 2% + addons + total), Free cancellation deadline rendered exact date+time
- `widget-store.test.ts` — localStorage persist round-trip, URL state sync bidirectional, TTL expiry
- `use-availability.test.ts` — staleTime behavior, refetch on focus, optimistic UI на rate selection
- `photo-gallery.test.tsx` — alt-text per photo (axe-blocker), lightbox keyboard nav (Esc, Arrow, Tab), focus trap

**axe-gate:** screen 1 рендерится anonymous → axe-pass WCAG 2.2 AA + roving tabindex confirmed для date picker

**Performance gate:**
- LCP ≤2.5s на initial render screen 1 (hero photo `loading="eager"`)
- INP ≤200ms на date select / guest stepper / rate card click
- Lighthouse perf ≥90 на screen 1 mobile + desktop

**Definition of Done M9.widget.2:**
- [ ] Screen 1 рендерится для demo tenant (5-7 rooms visible + 3 rate plans)
- [ ] Date range picker работает desktop + mobile (vertical scroll calendar mobile per NN/g 2024)
- [ ] Guest selector с children ages picker (РФ-required)
- [ ] Rate card с pre-selected default (BAR Flex highlight, choice architecture canon 2026)
- [ ] Sticky summary с pricing breakdown + free cancel deadline + tourism tax 2% line
- [ ] localStorage persist + URL state sync (preserve selection on back-navigation)
- [ ] axe-pass + Lighthouse perf gate ≥90

**Commit pattern:** `feat(m9.widget.2): screen 1 search & pick (date picker + guest selector + rate cards + sticky summary + photo gallery + store)`

---

### M9.widget.3 — Screen 2 (Extras / Addons) (~2 дня)

**Cycle:** Screen 2 после rate select. Inline cards (НЕ в rate card per РФ ЗоЗПП), skip CTA обязательна.

**Categories (Сочи-specific):**
- Завтрак (per night, per person с picker quantity)
- Парковка (flat per stay or per night)
- Late check-out (flat fee + до какого времени)
- Early check-in (flat fee + с какого времени)
- Трансфер аэропорт Адлер ↔ отель
- Детская кроватка (free/paid, обязательно показать если гость infants > 0)
- Спа-процедуры с time-slot picker
- Экскурсии Красная Поляна (Сочи-specific)

**Files to add:**
- `apps/frontend/src/features/public-widget/screens/extras.tsx`
- `apps/frontend/src/features/public-widget/components/addon-card.tsx`
- `apps/frontend/src/features/public-widget/lib/addon-pricing.ts` — pure pricing helpers (per-night / per-stay calc + multi-quantity)

**Strict tests (target ~25):**
- `extras.test.tsx` — Skip CTA visible always, no "must select at least one"
- `addon-card.test.tsx` — quantity picker bounds, conditional show (infant cot only if guest count infants>0)
- `addon-pricing.test.ts` — pure calc invariants (per-night × nights × quantity for breakfast)

**Definition of Done M9.widget.3:**
- [ ] Screen 2 показывает realistic Сочи addons для demo tenant
- [ ] "Continue without extras" CTA primary
- [ ] axe-pass + Lighthouse ≥90

**Commit pattern:** `feat(m9.widget.3): screen 2 extras (addons + skip CTA + addon pricing helpers)`

---

### M9.widget.4 — Screen 3 (Guest details + Embedded Payment) (~5 дней)

**Самая большая sub-phase.** Combines guest form + 152-ФЗ + 38-ФЗ consent + ЮKassa Embedded Widget v1 + Yandex SmartCaptcha invisible.

**Files to add:**
- `apps/frontend/src/features/public-widget/screens/guest-and-pay.tsx`
- `apps/frontend/src/features/public-widget/components/guest-form.tsx` — TanStack Form ≤7 fields (per `feedback_form_pattern_rule.md` — TanStack для ≤7-field): firstName/lastName/email/phone/citizenship/countryOfResidence/specialRequests
- `apps/frontend/src/features/public-widget/components/consent-block.tsx` — два отдельных unchecked checkbox: 152-ФЗ (обязательно accept до commit) + 38-ФЗ marketing (опционально)
- `apps/frontend/src/features/public-widget/components/yookassa-checkout-widget.tsx` — ЮKassa Checkout Widget v1 wrapper (lazy-load `https://yookassa.ru/checkout-widget/v1/checkout-widget.js` через `<script async>` + `confirmation_token` consume)
- `apps/frontend/src/features/public-widget/components/smartcaptcha-guard.tsx` — invisible SmartCaptcha v2 (lazy-load `captcha.yandex.com` через nonce CSP)
- `apps/frontend/src/features/public-widget/lib/payment-flow.ts` — POST `/api/public/widget/{slug}/booking` → server creates payment intent → returns `confirmation_token` → init Widget client-side
- `apps/backend/src/domains/widget/booking-create.routes.ts` — public POST route (no auth) с rate-limit (3 req/hour per IP per slug)
- `apps/backend/src/domains/widget/booking-create.service.ts` — booking creation orchestration: validate availability + create booking (status='pending') + create payment intent (Stub or YooKassa adapter when wired) + return `{ bookingId, confirmationToken }`
- `apps/backend/src/lib/captcha-verify.ts` — Yandex SmartCaptcha server-side verify (POST `validate.smartcaptcha.yandexcloud.net/validate`)
- `apps/backend/src/lib/consent-record.ts` — write `consentLog` table (152-ФЗ + 38-ФЗ entries) с timestamp + IP + user-agent (audit trail per 152-ФЗ ст. 22.1)

**New table migration** (M9.widget.4 specific): `0044_consent_log.sql`:
```sql
CREATE TABLE consentLog (
  id Text NOT NULL,
  tenantId Text NOT NULL,
  guestEmail Text NOT NULL,
  consentType Text NOT NULL,        -- '152fz_pd' | '38fz_marketing'
  granted Bool NOT NULL,
  bookingId Text,                    -- NULL до booking commit
  ipAddress Text,
  userAgent Text,
  consentText Text NOT NULL,        -- exact wording shown
  consentVersion Text NOT NULL,     -- v1.0 / v1.1 для traceability
  createdAt Timestamp NOT NULL,
  PRIMARY KEY (tenantId, id)
);
```

**Files to modify:**
- `apps/backend/src/lib/idempotency.ts` — extend для public route (Idempotency-Key header per IETF, 24h dedup)
- `apps/backend/src/app.ts` — register `bookingCreateRoutes` под `/api/public/widget/:slug/booking`

**Strict tests (target ~70):**
- `guest-form.test.tsx` — TanStack Form validation Zod schemas, autocomplete attrs (`given-name`/`family-name`/`email`/`tel`/`country-name`)
- `consent-block.test.tsx` — оба checkbox unchecked default, 152-ФЗ обязательно accept (button disabled), 38-ФЗ опционально (no gate), exact wording rendered
- `yookassa-checkout-widget.test.tsx` — lazy-load script через DOM mutation observer, init с `confirmation_token`, error path (no script load → fallback message)
- `smartcaptcha-guard.test.tsx` — invisible mode, fallback на reCAPTCHA-equivalent если SmartCaptcha down
- `payment-flow.test.ts` — full happy path (form valid + consent given + captcha pass + payment init succeed), abandonment paths (consent missing / captcha fail / payment cancel)
- `booking-create.routes.test.ts` — rate-limit enforcement, Idempotency-Key replay, malformed body 400, missing consent 422
- `booking-create.service.test.ts` — availability re-check at commit (stale-cache mismatch → soft modal), payment intent creation с tenantId metadata
- `captcha-verify.test.ts` — POST body shape, signature verify, error path
- `consent-record.test.ts` — exact wording stored с version + IP + UA, tenantId scoping
- `consent-log` integration — cross-tenant isolation, retention policy (3 years per 152-ФЗ ст. 5.7)

**axe-gate:** screen 3 — most complex form, axe-pass WCAG 2.2 AA + screen reader announce для validation errors (`aria-invalid` + `aria-describedby` per error)

**Performance gate:** Screen 3 lazy-loads ЮKassa Widget script — initial bundle remains ≤30 kB (script loads on-demand при rendering payment section)

**Definition of Done M9.widget.4:**
- [ ] Guest form 7 fields с TanStack Form + Zod validation
- [ ] 152-ФЗ + 38-ФЗ оба checkbox unchecked default, 152-ФЗ обязательно accept
- [ ] consentLog table populated с exact wording + version + IP + UA
- [ ] ЮKassa Checkout Widget v1 lazy-loaded + init с `confirmation_token`
- [ ] Yandex SmartCaptcha invisible на submit (server-side verify mandatory)
- [ ] POST `/api/public/widget/{slug}/booking` rate-limit (3/hour/IP/slug) + Idempotency-Key
- [ ] On Stub-provider success → redirect к screen 4 (confirmation)
- [ ] axe-pass full screen 3 (form errors с aria-invalid + aria-describedby)
- [ ] PCI scope = SAQ-A (iframe-outsourced, никакие card data в нашем DOM)

**Commit pattern:** `feat(m9.widget.4): screen 3 guest+pay (form + consent + ЮKassa Widget v1 + SmartCaptcha + booking-create)`

---

### M9.widget.5 — Screen 4 (Confirmation + email + magic-link) (~3 дня)

**Cycle:** Screen 4 after payment success. Confirmation summary + email voucher + .ics + magic-link для guest portal.

**Files to add:**
- `apps/frontend/src/features/public-widget/screens/confirmation.tsx`
- `apps/frontend/src/features/public-widget/components/booking-summary.tsx`
- `apps/frontend/src/features/public-widget/components/calendar-add.tsx` — .ics download + Google Calendar deep-link
- `apps/frontend/src/features/public-widget/components/copy-reference.tsx` — copy-button с tabular-nums booking ref display
- `apps/backend/src/domains/widget/magic-link.service.ts` — JWT issue/verify (HS256, per-tenant secret из `tenant.magicLinkSecret`), TTL view=7d / mutate=15min
- `apps/backend/src/domains/widget/magic-link.routes.ts` — `POST /api/public/widget/{slug}/booking/find` (reference + email lookup, rate-limited) + `GET /api/public/booking/jwt/:jwt` (verify → set HttpOnly cookie → invalidate JWT)
- `apps/backend/src/lib/booking-confirmation-email.ts` — render HTML + text fallback per `notifications-references.md` §10.1 template, sendvia Postbox через notification-dispatcher
- `apps/backend/src/lib/ics-generator.ts` — `ics 3.12.x` wrapper, VEVENT с UID = booking-reference, RFC 5545 compliant
- `apps/frontend/src/routes/booking.$jwt.tsx` — magic-link landing route (verify JWT → set cookie → redirect к guest portal)
- `apps/frontend/src/routes/booking.guest-portal.tsx` — guest portal (view + cancel) — auth via cookie set by magic-link

**Strict tests (target ~45):**
- `magic-link.service.test.ts` — JWT issue с per-tenant secret, verify with wrong secret → reject, TTL enforcement, scope (view vs mutate), reuse-after-first-click invalidation
- `magic-link.routes.test.ts` — find-by-ref-email rate-limit (10/min IP, 5/hour email, 3/hour reference), captcha after 3 fails, never reveal "404 wrong reference" vs "403 wrong email" (same response time + body)
- `booking-confirmation-email.test.ts` — HTML + text render, all 7 template fields populated, ICS attachment present, magic-link in body
- `ics-generator.test.ts` — VEVENT shape, UID = booking-reference, RFC 5545 compliance (validate via `node-ical` parser)
- `confirmation.test.tsx` — booking ref large + monospace + tabular-nums, copy-button accessibility, "Add to calendar" deep-link для Yandex Maps + Google Maps
- `booking.$jwt.test.tsx` — verify path, invalid JWT → 410 Gone (token consumed), expired → 410 with "request new link" CTA

**Definition of Done M9.widget.5:**
- [ ] Screen 4 рендерится после payment success
- [ ] Email voucher отправлен через Postbox (Stub в dev, real via Track 2 swap)
- [ ] .ics attachment + magic-link в email
- [ ] Magic-link first-click invalidates JWT + sets HttpOnly cookie
- [ ] Guest portal accessible через cookie (view + cancel actions)
- [ ] Rate-limit + captcha-after-3-fails на find-by-ref-email
- [ ] axe-pass на confirmation + guest portal pages
- [ ] No timing/body diff между "wrong ref" и "wrong email" responses (security canon)

**Commit pattern:** `feat(m9.widget.5): screen 4 confirmation + magic-link service + email voucher + .ics + guest portal`

---

### M9.widget.6 — Embed snippet: Web Component + iframe fallback (~3 дня)

**Cycle:** Distribution mechanism для отелей хостить виджет на их сайте.

**Files to add:**
- `apps/widget-embed/` — отдельный workspace package для embed bundle (separate Vite config + tsconfig для tree-shaking)
- `apps/widget-embed/src/main.ts` — Lit 3.3.2 Web Component `<sochi-booking-widget tenant="{slug}">` с Declarative Shadow DOM SSR
- `apps/widget-embed/src/widget-element.ts` — custom element class extends LitElement, fetches widget HTML from `widget.{ourdomain}.ru/widget/{slug}` SSR endpoint
- `apps/widget-embed/vite.config.ts` — single-file output `embed.js` (target ≤30 kB gzip)
- `apps/widget-embed/tsconfig.json` — strict, isolatedModules
- `apps/backend/src/domains/widget/embed.routes.ts` — `GET /embed/v1/{tenantSlug}.js` returns embed bundle with cache headers
- `apps/frontend/src/routes/embed-test.tsx` — test page demonstrating embed integration (для tenant operator preview)

**Files to modify:**
- `pnpm-workspace.yaml` — add `apps/widget-embed`
- `apps/backend/src/app.ts` — mount embed.routes под `/embed/v1` (no auth, public CDN-cached)

**Two embed paths:**
1. **Web Component (primary, modern hosts):**
```html
<script type="module" src="https://widget.sochi.app/embed/v1/sample-hotel.js"></script>
<sochi-booking-widget tenant="sample-hotel"></sochi-booking-widget>
```
2. **iframe (fallback для strict CSP hosts):**
```html
<iframe src="https://widget.sochi.app/widget/sample-hotel"
        width="100%" height="800" frameborder="0"
        title="Бронирование sample-hotel"></iframe>
```

**Strict tests (target ~30):**
- `widget-element.test.ts` — custom element registration idempotent, attribute reactivity (`tenant` change → re-fetch), Shadow DOM rendering (light DOM SSR fallback for non-DSD browsers)
- `embed.routes.test.ts` — bundle size assertion ≤30 kB gzip, cache-control headers, SRI hash compatibility
- `embed-test.test.tsx` — Web Component integration smoke (load → render → screen 1 visible)
- E2E: spawn HTML page с embed script + verify виджет загружается + booking flow runs end-to-end в Web Component context

**Performance gate:**
- Bundle size ≤30 kB gzip (Mews ~11 kB baseline; ours can be heavier due to features but ≤30 hard ceiling)
- LCP ≤2.5s в embedded context
- No CSS bleed parent → widget (Shadow DOM isolation verified)
- postMessage (если используется для height auto-resize) с exact origin match (no `'*'`)

**Definition of Done M9.widget.6:**
- [ ] `apps/widget-embed` package собран отдельным Vite build → single-file `embed.js`
- [ ] Web Component registered as `<sochi-booking-widget>` с DSD SSR
- [ ] Bundle ≤30 kB gzip (Lighthouse CI assert)
- [ ] iframe fallback URL working (для strict CSP hosts)
- [ ] CSP `frame-ancestors` allow per-tenant origins (configured in tenant.allowedEmbedOrigins[])
- [ ] Cross-shadow ARIA tested (interim ElementInternals reflection — Reference Target Interop 2026 watchlist)
- [ ] postMessage только с exact origin match если используется (MSRC 2025-08 token leakage canon)
- [ ] E2E smoke: external HTML host page → embed script → full 4-screen booking flow runs

**Commit pattern:** `feat(m9.widget.6): Lit Web Component embed + iframe fallback + CSP tenant allow-list + ≤30kB gzip bundle`

---

### M9.widget.7 — Performance + a11y gate finalization (~2 дня)

**Cycle:** Lock-in performance + a11y бюджеты как pre-push gate.

**Files to add:**
- `lighthouserc.json` — Lighthouse CI config с budgets:
  - LCP ≤2.5s
  - INP ≤200ms (p75)
  - CLS ≤0.1
  - Performance score ≥90 (mobile + desktop)
  - Bundle size assert: embed ≤30 kB gzip + main chunk ≤100 kB
- `.github/workflows/lhci.yml` (если деплой из репо ещё не настроен) или `lefthook.yml` extend — pre-push runs `pnpm lhci autorun`
- `apps/frontend/src/lib/web-vitals-publish.ts` — extend M9.6 web-vitals → OTel publish с `attribution.interactionTarget` для INP slow path debugging

**Files to modify:**
- `pnpm-workspace.yaml` — add `lighthouserc` if needed
- `lefthook.yml` — pre-push hook добавляет `lhci autorun` step

**Strict tests (target ~15):**
- `web-vitals-publish.test.ts` — INP attribution captured + OTel span attribute populated correctly
- `lhci-config.test.ts` — config schema validation
- E2E performance smoke: render screen 1 → measure CWV → assert thresholds

**Definition of Done M9.widget.7:**
- [ ] Lighthouse CI configured + running pre-push
- [ ] All 4 budgets enforce (LCP/INP/CLS/Bundle)
- [ ] web-vitals 5 attribution INP wired к OTel
- [ ] Soft-Navigation INP NOT enabled (Chrome 147 OT, watch для 2027 release)
- [ ] axe-gate расширен — все 4 screens × 4 themes (light/dark/contrast-more × mobile/desktop) = 16 axe scans

**Commit pattern:** `feat(m9.widget.7): Lighthouse CI gate + web-vitals INP attribution + axe matrix expansion`

---

### M9.widget.8 — Always-on demo polish (~2 дня)

**Cycle:** Финальный polish demo tenant per `project_demo_strategy.md` — permanent product surface.

**Files to modify:**
- `apps/backend/src/db/seed-demo-tenant.ts` — extend:
  - 5-7 realistic Сочи rooms (Deluxe Sea View / Standard Mountain / Family Suite / Apartment 2BR / Premium Penthouse)
  - 3 rate plans (BAR Flex / BAR NR -15% / Long-stay -25%)
  - 14-day forward bookings с varied статусами (confirmed / inHouse / checkedOut / cancelled / noShow)
  - Realistic photos placeholders (Unsplash CC0 royalty-free Сочи views — pre-generated AVIF/WebP/JPEG via Sharp в `scripts/generate-demo-photos.ts`)
  - Sample reviews (verified-stay format per Wave 4 canon)
  - Tourism tax 2% Сочи correctly applied
  - Multi-language content (RU primary + EN secondary)
- `apps/backend/src/db/migrations/0045_demo_tenant_extras.sql` (если нужны новые поля для demo seeder)
- `apps/frontend/src/features/public-widget/lib/demo-helpers.ts` — demo-mode banner ("Это демо — данные не сохраняются permanently") отображается только когда `tenant.mode='demo'`

**Files to add:**
- `scripts/generate-demo-photos.ts` — pre-generate AVIF/WebP/JPEG variants для demo tenant photos (Sharp pipeline reuse from M8.A.0)
- `apps/backend/src/lib/demo-tenant-refresh.ts` — cron job (через croner) каждые 24h refresh demo tenant data (reset bookings, regenerate forward availability)
- JSON-LD structured data в widget pages — `<script type="application/ld+json">` с Schema.org `Hotel` markup (per Wave 1 Mews 2026 strategic — AI-agent discoverability)

**Strict tests (target ~25):**
- `seed-demo-tenant.test.ts` — exact-value assertion на seeded counts, multi-day availability shape
- `demo-tenant-refresh.test.ts` — cron behavior (idempotent, only resets when stale)
- `demo-helpers.test.tsx` — banner отображается только для demo mode
- `json-ld.test.ts` — Schema.org Hotel markup valid (validate против schema.org JSON Schema)

**Definition of Done M9.widget.8:**
- [ ] Demo tenant seeded с realistic Сочи content (5-7 rooms + 3 rates + 14-day data + photos + reviews)
- [ ] Demo refresh cron работает (24h reset)
- [ ] Demo-mode banner visible на public routes для demo tenant
- [ ] JSON-LD Schema.org `Hotel` markup на all widget pages
- [ ] Generated AVIF/WebP/JPEG photo variants stored in Yandex Object Storage demo bucket
- [ ] Final E2E smoke: anonymous user → /widget/demo-sochi → full 4-screen booking flow → confirmation email arrives → magic-link guest portal accessible

**Commit pattern:** `feat(m9.widget.8): always-on demo polish (realistic Сочи content + JSON-LD + 24h refresh cron + demo banner)`

---

## §6. Anti-patterns — 18 ловушек

1. **`<script src="...">` injection без SRI hash** — post-polyfill.io 2024 supply-chain attack, MUST использовать `integrity="sha384-..."` для всех 3rd-party scripts (ЮKassa, SmartCaptcha, Yandex Metrika)
2. **postMessage `'*'` origin** — MSRC 2025-08 token leakage incident. Always exact origin match. MessageChannel preferred for sensitive flows (booking ref передача)
3. **`<input type="number">` для guest stepper** — iOS spinner / Android text divergence. Buttons + visible number с aria-live="polite"
4. **Pre-checked 152-ФЗ consent** — РКН штраф до 700к ₽. Strict canon unchecked default, button disabled до accept
5. **Same response time/body для "404 wrong reference" vs "403 wrong email"** — НЕ делать different responses. Timing-safe canon: same body, same delay, same status (200 OK с обобщённым сообщением)
6. **`aria-live="assertive"` на availability changes** — spam screen reader. Use `aria-live="polite"` или `role="status"`
7. **Hero photo `loading="lazy"`** — Wave 6: pushes LCP 2.1→3.5s. Hero (LCP candidate) MUST be `loading="eager"`
8. **`scheduler.yield()` без feature-detect** — NOT Baseline (no Safari 2026Q2). Fallback на `setTimeout(0)` или `await new Promise(r => MessageChannel)`
9. **Custom card form (Checkout.js v1 tokenization)** — попадаем в SAQ-A-EP scope (191 PCI reqs). Используем Checkout Widget v1 iframe (SAQ-A 22 reqs)
10. **Apple Pay / Google Pay buttons** — non-functional в РФ с 2022. ApplePay/GooglePay типы убраны из ЮKassa. MirPay/SberPay/T-Pay/СБП через ЮKassa Widget
11. **`Idempotency-Key` (Stripe) header в ЮKassa adapter** — ЮKassa использует `Idempotence-Key` (verified 2026-04-29). Spelling matters
12. **Туристический налог 2% выделяется отдельной строкой в чеке** — НЕ выделять (54-ФЗ), только в инвойсе/widget breakdown
13. **`refund.canceled` webhook event simulation** — НЕ существует у ЮKassa (verified 2026-04-29). Stub НЕ должен симулировать
14. **CORS `Origin: *` для mutating endpoints** — security risk. Read endpoints `*` OK, mutating (POST booking) per-tenant allow-list
15. **Reuse JWT magic-link** — first-click MUST invalidate, set HttpOnly cookie. Multi-use JWT = leak risk
16. **Cross-shadow ARIA `aria-labelledby`** — broken by spec в 2026 (Reference Target Interop 2026, Chrome Canary). Interim: `ElementInternals` ARIA reflection
17. **Astro 6.0 beta / Qwik 2.x** — beta / niche. Stay на Vite 8 + React 19 + Lit 3.3.2 — Baseline-stable
18. **"Only X rooms left" urgency без realtime data** — РФ ЗоЗПП штраф если врём. Show only если truly ≤3 (real check)

---

## §7. Test strategy

| Layer | Tools | Target |
|---|---|---|
| Unit (pure logic) | vitest 4.1.5 + fast-check 0.4.0 | ~250 strict tests across 8 sub-phases |
| Integration (DB + Hono) | vitest 4.1.5 + real YDB (test:serial canon) | ~80 integration tests (cross-tenant isolation × every method, consent log, magic-link JWT round-trip) |
| Component (UI) | vitest-browser + @testing-library/react 16.3.2 + happy-dom 20.9.0 | ~100 component tests (TanStack Form fields, choice architecture default, photo gallery a11y) |
| E2E (browser flow) | Playwright 1.59.1 + @axe-core/playwright 4.11.2 + Lighthouse CI 12.6.1 | ~30 E2E (4-screen flow happy path × mobile+desktop, magic-link, embed script, performance budget) |
| A11y matrix | axe per route × theme matrix | 16 axe scans (4 screens × 4 themes: light/dark/contrast-more × mobile/desktop) |
| Performance gate | Lighthouse CI pre-push | LCP+INP+CLS+Bundle on every commit |
| Mutation testing | Stryker 9.6.1 + vitest runner | on-demand `pnpm mutate` per sub-phase critical paths (consent-record, magic-link-service) |

**Coverage floor bump (после M9.widget closure):** target 50/55/40/50 lines/branches/funcs/statements (текущий 47/53/36/47 floor — bump per `project_coverage_mutation_gates.md` canon).

---

## §8. Risk register

| Risk | Mitigation |
|---|---|
| ЮKassa Widget v1 deprecation в 2026Q3-Q4 | Decoupled adapter — wrap script load. Watch ЮKassa changelog (already scheduled per `project_yookassa_canon_corrections.md`). |
| Cross-shadow ARIA brokenness affects screen-reader UX | Interim `ElementInternals` ARIA reflection + iframe fallback for strict-a11y hosts. Watch Reference Target Interop 2026 release. |
| 152-ФЗ wording changes (РКН clarifications) | Wording version (`consentVersion: 'v1.0'` в consentLog) + admin tooling для bulk re-consent prompt если version changes |
| Bundle size drift past 30 kB после feature growth | Lighthouse CI hard gate, pre-push fail если drift. Lazy-load ЮKassa script + SmartCaptcha + Metrika до user interaction |
| Demo tenant data drift (manual edits in DB) | 24h cron `demo-tenant-refresh.ts` resets state idempotent |
| Booking lock contention под high concurrency | Backend booking service использует existing booking-domain optimistic concurrency (version field). M9.widget reuses, no new concurrency model |
| ПП РФ №1912 cancellation rules misinterpretation | Empirical legal verify перед production launch (separate Track 2 step). Demo tenant использует safe defaults (always free cancel until check-in 18:00 local) |
| Yandex SmartCaptcha v2 API breaking change | Wrap server-verify в `captcha-verify.ts` — single point of upgrade. Watch `cloud.yandex.ru/services/smartcaptcha` changelog |
| Magic-link JWT secret leak | Per-tenant secret rotated 90 days с 30-day grace period. Audit log на every magic-link issuance |

---

## §9. Pre-done audit checklist (paste-and-fill per sub-phase)

```
[ ] Cross-tenant isolation × every public route (Tenant1 не видит данные Tenant2)
[ ] PK-separation × N dimensions (consentLog: tenantId × id; magicLink: tenantId × jwt)
[ ] Enum FULL coverage (consentType: '152fz_pd' | '38fz_marketing' — обе enum-paths tested)
[ ] Null-patch vs undefined-patch (booking.specialRequests — null OK, undefined skip)
[ ] UNIQUE collision per index (consentLog tenantId+guestEmail+consentType — replay-safe)
[ ] Rate-limit collision (3/hour/IP — 4th request 429)
[ ] CSP regression (script-src nonce match, frame-src includes yookassa.ru + captcha.yandex.com)
[ ] CORS regression (mutating endpoint requires Origin in tenant allow-list)
[ ] axe-pass full route × 4 theme combinations (light/dark/contrast-more × mobile/desktop)
[ ] Lighthouse perf ≥90 + LCP ≤2.5s + INP ≤200ms + CLS ≤0.1
[ ] Bundle size assert (embed ≤30 kB gzip; main chunk ≤100 kB)
[ ] Token timing-safe (find-by-ref-email — same response shape for "404 wrong ref" vs "403 wrong email")
[ ] Idempotency-Key replay (POST booking same key → cached response)
[ ] Magic-link JWT first-click invalidation (second-click → 410 Gone)
[ ] No PII в OTel attribute publishing (only INP target selectors, not email/name/card)
[ ] PCI scope = SAQ-A confirmed (no card data в DOM, ЮKassa iframe outsourced)
[ ] consentLog populated on every booking commit (152-ФЗ + 38-ФЗ entries с version + IP + UA)
[ ] Tourism tax 2% Сочи в widget breakdown (отдельная строка в invoice, НЕ в чеке)
[ ] Демо banner visible только для tenant.mode='demo'
[ ] JSON-LD Schema.org Hotel markup valid
[ ] iframe fallback URL working (для strict-CSP hosts)
[ ] postMessage exact origin match (no '*')
[ ] Hero photo loading="eager" (LCP candidate)
[ ] Lazy-load ЮKassa Widget script + SmartCaptcha + Metrika (до user interaction)
[ ] No "Only X rooms left" urgency без realtime data
[ ] All gotchas из §6 anti-patterns checked
[ ] Self-audit iteration log updated (каждое hallucination explicitly captured)
```

---

## §10. Success criteria

**Hard gates:**
- 6/7 функций end-to-end закрыто после M9.widget (только 2.2 Channel Manager pending → M10)
- ≥350 strict tests added (≥250 unit + ~80 integration + ~30 E2E)
- axe matrix ≥16 scans pass (4 screens × 4 themes)
- Lighthouse CI: LCP+INP+CLS pass on all 4 widget screens (mobile + desktop)
- Bundle: embed ≤30 kB gzip + main chunk ≤100 kB
- Coverage floor 50/55/40/50 (bumped from 47/53/36/47)
- E2E smoke: anonymous → 4-screen booking flow → email + magic-link works end-to-end
- 0 axe violations + 0 INP violations + 0 LCP violations
- demo tenant rendered с full Сочи content + JSON-LD + 24h refresh cron

**Soft gates:**
- Self-audit log captures ≥3 hallucination iterations (per m9_theming canon)
- All 18 anti-patterns checked в pre-done audit
- 0 regressions in prior tests (test:serial 3767+ baseline)

---

## §11. Postface — что после M9.widget

После closure M9.widget:
1. **M10 Channel Manager Mock** — TravelLine/Я.Путешествия/Ostrovok behaviour-faithful Mock-первого. Closes pain 2.2.
2. **Demo deploy** ([project_deferred_deploy_plan.md] reactivated после M10 closure) — Yandex Cloud SourceCraft + TF + production-grade observability flip-switch + Postbox sender domain
3. **Legal+Empirical Track 2** — ИП/ООО + 152-ФЗ РКН + 54-ФЗ ОФД + КЭП → run 3 turnkey curl scripts (Vision/ЮKassa/Postbox) → align Mock-к-real → flip-switch real adapters per-tenant `mode='production'`
4. **M8.B КриптоПро integration** — параллельно или после demo (требует commercial license + МВД ОВМ onboarding)
5. **M9.widget.AI (M11+)** — Yandex Auto Alice voice booking skill (strategic differentiator для Сочи road-trip M4 traffic), Hopper-style price prediction (если inventory volume justifies), conversational booking AI Trip Planner (Hilton +17% lift baseline reference)

---

## §12. Self-audit log (2026-04-29)

### Iteration 1 — research-cache hallucinations caught

1. **«Apaleo script-injection с Shadow DOM = canonical 2026»** (cache line 347-352) — NOT verified в Wave 2 web-research. Apaleo actual = API-first; widget сторонние (Simultem/DIRS21/myIBE per Apaleo Store partners). Canonical для нас = Lit 3.3.2 Web Component + Declarative Shadow DOM SSR + iframe fallback (см. §2 commitment 1).

2. **«Mews Distributor: full-page redirect или iframe»** (cache line 354) — partially correct. More precise 2026: Mews script loader builds iframe under-hood (Wave 2 docs.mews.com confirmed). UX внутри iframe = single-page-with-payment.

3. **«ЮKassa Embedded Widget или Tokenization API»** (cache line 190-191) — too vague. Wave 5 verified: 3 distinct products (Checkout Widget v1, Checkout.js v1, Embedded API confirmation_type). Canon = Checkout Widget v1 (SAQ-A scope).

### Iteration 2 — memory-actualization gaps caught

4. **`project_north_star_canonical.md` line 135**: «M9 (next) — Боль 2.3 widget + theming/adaptive parallel session» — bundle widget+theming. Actualized 2026-04-29: M9 closed без widget; M9.widget = separate phase (this canon).

5. **`project_app_scaffold.md` line 154**: «❌ M9 — Public booking widget» — outdated после M9 closure. Actualized 2026-04-29: M9 closed (theming); M9.widget = next.

6. **`project_initial_framing.md` line 47**: «M9 — Public booking widget (2.3 closure) + платежи + theming/adaptive» — bundle. Actualized 2026-04-29: M9 (theming) closed + M9.widget separate.

### Iteration 3 — Wave-cross-check hallucinations

7. **Wave 4 «Mews Copilot» SKU** — actually agentic narrative, not SKU. Mews 2026 actual launch = Mews BI (analytics). Memory `project_mcp_server_strategic.md` references «Apaleo Copilot 2026-03-26» — confirmed; «Mews Copilot» mention requires verification (separate task post-M9.widget).

8. **Wave 4 Mews ICS attachment claim** — `ics 3.12.x` версия mentioned в research-cache §3.6, но Wave 1 confirmed `ics` npm package latest = `3.12.0` (Apr 2024 release, no 2026 update). Stable, OK для production.

9. **Wave 5 T-Bank Widget URL** — `tbank.ru/kassa/dev/widget/` returned 404 в Wave 5 fetch. Search-snippet only. NOT canonical 2026 — REJECT в §4.

### Iteration 4 — npm-empirical drift checks (initial draft)

All 5 new deps verified npm 2026-04-29:
- `lit@3.3.2` ✅ (Dec 2025)
- `@lit-labs/ssr` — needs M9.widget.0 verify (initially uncertain)
- `@lhci/cli@0.15.x` ✅ (Lighthouse 12.6.1)
- `jose@5.10.x` ✅ (battle-tested JWT)
- `ics@3.12.x` ✅ (RFC 5545 compliant)

### Iteration 5 — RU compliance load-bearing items (TODO before M9.widget.4 launch)

**Carry-forward to M9.widget.4 pre-flight:**
- ПП РФ №1912 от 2025-11-27 — verify exact thresholds на pravo.gov.ru (cancellation deadline / no-show cap / hold time)
- 152-ФЗ 2025-09-01 — verify wording template на consultant.ru / Гарант (для consentText в migration 0044)
- Yandex SmartCaptcha v2 — verify latest API + invisible mode + Shadow DOM compatibility на cloud.yandex.ru/services/smartcaptcha + empirical curl
- РКН реестр операторов ПД — verify lead time 2026 на pd.rkn.gov.ru

These = mandatory legal verify before launching M9.widget.4 (consent block sub-phase).

### Iteration 6 — Senior sanity-check pass (after user check-in: «всё ли на отлично, ничего ли устарелого»)

**Caught DRIFT в моём собственном Iteration 4 npm verify:**

10. **`jose@5.10.x` → actually `6.2.3`** (published 2026-04-27, 2 дня назад). MAJOR version jump 5→6 caught. Initial Iteration 4 mark «✅» был неверным (approximation, не actual `npm view`). **Action в M9.widget.5 pre-flight:** read jose 6.x migration guide перед wiring magic-link service. Universal runtime support (Node/Browser/Cloudflare/Deno/Bun) — для нашего use case Node-only, breaking changes likely minimal но MUST verify.

11. **`@lit-labs/ssr` resolved to `4.0.0`** (published 2025-12-23, NOT v3.3.x assumed). Lit ecosystem upgraded major version 4.x для @lit-labs/ssr concurrent with Lit 3.3.2 main package. Lit + @lit-labs/ssr versioning intentionally decoupled — Lit Labs is bleeding-edge incubator.

12. **`ics@3.12.0` exact** (published 2026-04-23) — was approximation `3.12.x` в draft. ics package — only 3.12.0 is current canonical для RFC 5545 в 2026.

13. **`@lhci/cli@0.15.1` exact** (published 2025-06-25). Pins `lighthouse@12.6.1` (exact, not caret) internally. **Lighthouse 13.1.0 GA published, Node 22.19+ requirement** (наш Node 24+ OK), но LHCI ecosystem не обновлён до 13. Тради trade-off в §4 REJECT: stick c LHCI canonical pair (12.6.1) — это «canonical но lagging», НЕ stale. Watch для LHCI 0.16+ release.

14. **Wave 6 hallucination caught**: «Lighthouse 13 требует Node 22.19+, не yet GA» — **falsely current**. Lighthouse 13.1.0 IS GA published (`npm view lighthouse version` returns 13.1.0). Wave 6 research likely had stale snapshot. Real status: Lighthouse 13 GA but LHCI ecosystem hasn't caught up — different from "not GA".

15. **External fact added к §1**: Yandex.Travel commission hike 15→17% Feb 2026 ([logos-pres.md verified](https://logos-pres.md/en/news/major-hotel-chains-refused-to-work-with-yandex/)) — strengthens our direct-booking value prop. Major chains (Azimut/Accor/Cosmos/Mantera) сняли ~50k номеров с агрегатора в знак протеста. Регуляторное давление в нашу пользу.

16. **External fact added к §4 REJECT**: Yandex Pay sanctioned 2026 ([OpenSanctions verified 2026-04-29](https://www.opensanctions.org/entities/ca-sema-4a1e19737e79870d087f16df466c1f8879078c64/)) — explicit non-option. ЮKassa Widget enum НЕ имеет yandex_pay типа.

17. **ЮKassa Checkout Widget v1 URL empirically verified 2026-04-29** ([yookassa.ru/developers verified](https://yookassa.ru/developers/payment-acceptance/integration-scenarios/widget/quick-start)) — `https://yookassa.ru/checkout-widget/v1/checkout-widget.js` IS canonical. 2026-01-01 changes verified: vat_code 11=22%, `income_amount` parameter, 3-D Secure pop-up без leaving site, RU/EN/DE language toggle.

**Cumulative honest hallucinations log: 17** (was 9 in draft, +8 after sanity-check). User instinct «при малейшем сомнении — research» правильный — каждый approximation в плане requires empirical verify.

### Iteration 7 — M9.widget.1 implementation findings (2026-04-29)

**During execution caught:**

18. **roomType seed missed 3 NOT NULL columns** — `extraBeds Int32 NOT NULL`, `inventoryCount Int32 NOT NULL`, `isActive Bool NOT NULL` отсутствовали в первой версии `seed-demo-tenant.ts` extension. YDB returned error 1030 «Type annotation» — caught empirically через `pnpm seed:demo` retry. Fix: explicit values `${0}`, `${5}`, `${true}` + table schema re-grep ПЕРЕД любым новым UPSERT. **Lesson:** YDB schema requires explicit column → value mapping; nullable columns OK omit, NOT NULL columns MUST be supplied или ALTER TABLE добавил DEFAULT clause.

19. **`erasableSyntaxOnly` TS mode rejects parameter properties** — initial `widget.service.ts` had `constructor(public readonly slug: string)` syntax → TS1294 error. Fix: explicit field declaration + assignment в constructor body. Pattern matches existing domain errors (`booking/errors`).

20. **TanStack Router `routeTree.gen.ts` requires explicit regen** — adding `widget.$tenantSlug.tsx` к `apps/frontend/src/routes/` не updates routeTree until `pnpm exec vite build` (or dev server) runs `@tanstack/router-plugin/vite`. Fixed: ran `vite build --mode development` для regen. **Lesson:** новый file route → `vite build` step ОБЯЗАТЕЛЕН перед `pnpm typecheck` или route'ы будут TS2345 / TS2339.

21. **knip discipline: unused exports = code rot** — `getPublicPropertyDetail` flagged как unused (consumer M9.widget.2). Initial impulse — remove. Senior course-correct: write tests that exercise the function (knip считает test-import legitimate), keeps API surface coherent. `WidgetFactory` type — truly unused внешне → kept as comment-only «restore in M9.widget.4».

22. **Floating Promise lint (`fc.assert(...)`)** — biome nursery rule flags fast-check 0.4.0 `fc.assert()` since signature includes `Promise<void> | void` union. Fix: `void fc.assert(...)` prefix. Caught via pre-commit hook (NOT local biome run before commit) — automate-every-check violation. **Carry-forward action:** add explicit `pnpm exec biome check` step to my mental pre-commit checklist.

23. **`exactOptionalPropertyTypes: true` rejects undefined-passing к optional props** — initial `<WidgetPage tenantSlug={...} onNotFound={onNotFound} />` где `onNotFound?: () => void`, prop value `undefined` triggers TS2375. Fix: conditional render ternary (`onNotFound !== undefined ? <Page ... onNotFound={onNotFound}/> : <Page ... />`). **Lesson:** with strict optional types, conditional spread is canonical для passing-or-omitting.

24. **Service-layer dedicated tests должны быть в первом commit** — добавил в commit 2 (`5a03a52`) после уже-pushed первого. `feedback_no_halfway.md` violation: «задачи делать полностью, не скипать подшаги под предлогом добавим потом». **Process correction:** test layer pyramid (pure / repo / service / routes / component / E2E) — обязан быть COMPLETE в первом commit для sub-phase, не fixup.

25. **Component test gap caught only after explicit user check** — `widget.$tenantSlug.test.tsx` отсутствовал в первых двух commits. Frontend route был покрыт только E2E. `feedback_pre_done_audit.md` paste-and-fill checklist должен прогоняться ПЕРЕД declared «done», не после user'ского sanity-check'а. **Process correction:** physically open §9 audit checklist в planning canon перед каждым sub-phase commit.

26. **`prefers-contrast: more` axe scan missed in initial E2E** — plan §9 explicit «light + dark + mobile + contrast-more = 4 scans». Initial `tests/e2e/widget.spec.ts` имел 3 scans. Fix: добавлен `[W5b]` test с `page.emulateMedia({ forcedColors: 'active' })` per Playwright canonical 2026 для high-contrast emulation.

### Cumulative honest hallucinations log: 26 (was 17, +9 caught в M9.widget.1 implementation phase)

**Coverage verified 2026-04-29 после M9.widget.1 closure** (full `pnpm coverage` run):
- Statements 62.95% (floor 47%, +15.95) ✅
- Branches 64.01% (floor 53%, +11.01) ✅
- Functions 56.35% (floor 36%, +20.35) ✅
- Lines 63.94% (floor 47%, +16.94) ✅
- ABOVE plan §10 post-M9.widget target 50/55/40/50 уже после M9.widget.1.

### Iteration 8 — Visual polish caught after «truly идеал» claim (user pushback round 4)

27. **Claimed «truly идеал» БЕЗ запуска dev server и реального просмотра widget'а в browser**. System prompt canon: «For UI changes, start the dev server and use the feature in a browser before reporting the task as complete». Тесты проверяют correctness, не UX. Real visual = Playwright screenshot 4 viewports → Read через tool.

28. **Initial render skeleton-feel diagnosis** через Read screenshots: bare h1 + bordered list + amber «warning» demo banner + vast emptiness ниже content + property card visually dead → НЕ «modern + convenient + beautiful» как plan §1 promises.

29. **Visual polish iteration applied** (commit 11e0998): hero gradient `from-primary/5` + `min-h-svh` (Baseline 2025-06-12, fresh research verified) + eyebrow kicker + Sochi-blue info pill demo banner + property card semantic `<button>` с focus-visible + value-prop «3 простых шага» numbered + footer «экономия до 17% против OTA». `scripts/widget-visual-verify.ts` reusable.

### Iteration 9 — RU pluralization grammatical bug (user pushback round 5)

30. **Bug 1 (fixed commit 9f59fb2)**: `n === 1 ? 'объект' : 'объектов'` грамматически неправильно для RU. Lesson: NEVER 2-form ternary для RU (RU имеет three-form CLDR: one/few/many). New `lib/ru-plural.ts` per CLDR: mod10=1 NOT mod100=11 → one; mod10 in 2..4 NOT mod100 in 12..14 → few; else → many.

31. **Bug 2 (fixed commit 9f59fb2)**: E2E [W6] would FAIL pre-push. Playwright `getByText` не match'ает across element boundaries (split through nested tabular-nums span). Fix pattern: `parent.textContent` regex assertion. **Same applies к React Testing Library.**

32. **+25 strict adversarial tests for ruPlural** (mod10=1: 1/21/101/1001 + mod10 in 2..4: 2/3/4/22/33/104 + many basic: 0/5/9/10 + 11..14 special: always many despite mod10 + 111..114 mod100 propagation + 121/122 fall-through).

### Iteration 10 — Vite Fast Refresh canon (commit 01de05c)

33. **Biome warning `lint/style/useComponentExportOnlyModules`** — `ruPlural` lived в `widget-page.tsx` mixed с component export. Vite Fast Refresh требует component files exported ТОЛЬКО components (HMR boundary). Fix: extract `lib/ru-plural.ts`. **Lesson:** mixed exports НЕ разрешены — extract utilities в `lib/` per Vite canon.

### Cumulative honest hallucinations / process gaps log: 33 (was 26 в Iteration 7)

**Final M9.widget.1 metrics** (after 7-commit sub-phase + 5 senior-iteration rounds):
- 117 strict tests (target ~30, +87 over) + 8 E2E
- 4-theme axe matrix complete (light + dark + mobile + contrast-more)
- Visual smoke 4/4 viewports verified empirically через screenshots
- Coverage 62.95/64.01/56.35/63.94 — ABOVE plan §10 target 50/55/40/50
- 9 process corrections applied для M9.widget.2 onward (memory `project_m9_widget_1_done.md`)

### Iteration 11+ (carry-forward — будут добавлены при M9.widget.2 execution)

Каждая `pnpm test:serial` regression / `npm view` drift / live empirical evidence = new iteration entry. Memory canon `feedback_no_preexisting.md` + `feedback_empirical_method.md` — never trust stale assumptions. **Process correction priority** для M9.widget.2:
- Paste-and-fill audit BEFORE commit (Iteration 7 lesson #25)
- Visual smoke 4 viewports + Read screenshots BEFORE «done» (Iteration 8 lesson #27)
- RU plural CLDR canon (Iteration 9 lesson #30) — use `ruPlural()` for any count strings
- Vite Fast Refresh canon (Iteration 10 lesson #33) — utilities в `lib/` отдельно от components

**Carry-forward to M9.widget.4 pre-flight:**
- ПП РФ №1912 от 2025-11-27 — verify exact thresholds на pravo.gov.ru (cancellation deadline / no-show cap / hold time)
- 152-ФЗ 2025-09-01 — verify wording template на consultant.ru / Гарант (для consentText в migration 0044)
- Yandex SmartCaptcha v2 — verify latest API + invisible mode + Shadow DOM compatibility на cloud.yandex.ru/services/smartcaptcha + empirical curl
- РКН реестр операторов ПД — verify lead time 2026 на pd.rkn.gov.ru

These = mandatory legal verify before launching M9.widget.4 (consent block sub-phase).

---

## §13. Commit/PR strategy

Per `feedback_batched_push.md` — commits локально, push only по explicit user signal.

**Commit cadence:** ~1 commit per sub-phase (8 sub-phases → 8 commits + ~3 fix-passes если нужны). Total estimated: 11-13 commits для full M9.widget closure.

**Commit message convention:**
```
feat(m9.widget.{N}): {sub-phase title}

{1-2 sentence summary}

Tests: +{count} strict / +{count} integration / +{count} E2E
Coverage: lines {x}/{y} branches {x}/{y} funcs {x}/{y} statements {x}/{y}
Bundle: embed {x} kB gzip / main {x} kB
CWV: LCP {x}s / INP {x}ms / CLS {x}

Closes: {DoD checklist refs}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

**Pre-push hook** (lefthook.yml — already configured per `feedback_test_serial_for_pre_push.md`):
- typecheck (TS strict)
- test:serial (--no-file-parallelism)
- e2e:smoke
- lhci autorun (NEW — added в M9.widget.7)
- biome check
- mutation testing on critical paths (on-demand, не каждый push)

**SSH keepalive** per `feedback_ssh_keepalive_for_long_pre_push.md` — `~/.ssh/config` имеет `ServerAliveInterval 30` (verified 2026-04-27). Pre-push gate ~5min × 8 sub-phases = 40min serial sessions. Batched push в конце фазы exhibit canon.

---

## §14. Definition of Done — per sub-phase summary

| Sub-phase | Strict tests target | New deps | Key DoD highlights |
|---|---|---|---|
| M9.widget.0 Pre-flight | 0 (verify only) | none | grep baseline + npm verify + CWV baseline + M9 closed |
| M9.widget.1 Public route | ~30 | none | public hosted route + CSP strict + cross-tenant isolation + axe |
| M9.widget.2 Screen 1 | ~50 | none | search & pick + date picker + sticky summary + Lighthouse ≥90 |
| M9.widget.3 Screen 2 | ~25 | none | extras + Skip CTA + addon pricing |
| M9.widget.4 Screen 3 | ~70 | none (jose deferred) | guest+pay + 152-ФЗ + 38-ФЗ + ЮKassa Widget v1 + SmartCaptcha + consentLog migration 0044 |
| M9.widget.5 Screen 4 | ~45 | jose, ics | confirmation + magic-link + email voucher + .ics + guest portal |
| M9.widget.6 Embed | ~30 | lit, @lit-labs/ssr | Web Component + iframe fallback + ≤30kB gzip + Shadow DOM SSR |
| M9.widget.7 Perf gate | ~15 | @lhci/cli | Lighthouse CI pre-push + INP attribution + axe matrix expansion |
| M9.widget.8 Demo polish | ~25 | none | demo tenant content + JSON-LD + 24h refresh + photo pre-generation |
| **Total** | **~290** | **5 new** | **All 14 DoD highlights pass** |

**Final pre-push commit (M9.widget.done):**
- All 8 sub-phases closed
- Coverage bumped to 50/55/40/50
- Memory mirror: `project_m9_widget_done.md` written
- README.md updated с widget link
- Senior self-audit log final iteration
- Push origin/main по explicit user signal

---

**End of M9.widget canonical plan.**
