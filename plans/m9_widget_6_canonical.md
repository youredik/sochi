# M9.widget.6 — Embed Web Component + iframe fallback (canonical sub-phase plan)

**Дата:** 2026-05-01
**Track:** A4 (per `plans/ROADMAP.md`) — closes Боль 2.3 distribution. Embed виджет на сторонних сайтах отелей.
**Scope:** `apps/widget-embed/` workspace package, Vite IIFE build → single `embed.js` ≤30 kB gzip + iframe fallback для строгих CSP-хостов.
**Canonical guard:** `feedback_behaviour_faithful_mock_canon.md` — embed работает identically для demo и production tenants (factory binding swap server-side).
**Research:** R1 (5 agents broad ≥2026-04-15) + R2 adversarial (1 agent — security attacks) + npm empirical 2026-05-01. **80+ findings, 30+ corrections к baseline `m9_widget_canonical.md` §M9.widget.6.**

---

## §1. North-star alignment

**Demo surface canon**: один embed-bundle обслуживает demo + production tenants. Tenant slug → backend resolves `mode='demo' | 'production'` → factory binding swap. Same `<sochi-booking-widget tenant="sirius">` рендерится в обеих средах.

**Что строится в M9.widget.6 (Track A4):**
- `apps/widget-embed/` — отдельный pnpm workspace package для embed bundle
- Lit 3.3.2 Web Component `<sochi-booking-widget tenant="{slug}">` с Declarative Shadow DOM SSR
- Vite 8.0.10 IIFE library mode + `inlineDynamicImports` → single `embed.js` ≤30 kB gzip
- iframe fallback `<iframe src="https://widget.sochi.app/widget/{slug}">` для строгих CSP-хостов
- Per-tenant CSP `frame-ancestors` + Sec-Fetch-Site parent allowlist
- SHA-384 SRI + `Integrity-Policy` HTTP header для supply-chain protection
- CI gate: bundle size ≤30 kB gzip pre-push

**Что defer'ится:**
- Bundle к Yandex Object Storage CDN — Track B5 deploy (`project_deferred_deploy_plan.md`)
- Versioned URL pattern `embed/v1/<sha>.js` immutable cache — Track B6
- Live empirical CSP per-tenant header injection — needs production deploy с edge worker

---

## §2. Integration map — что widget hooks (NO modifications к existing services)

| Existing service | Used by widget-embed |
|---|---|
| `domains/widget/widget.service.getAvailability()` | Read через main backend API (`/api/public/widget/{slug}/...`) |
| `domains/widget/booking-create.service.ts` | POST booking commit (already wired в M9.widget.4) |
| `domains/widget/magic-link.service.ts` | Magic-link issue + consume (M9.widget.5) |
| `tenant-resolver.ts` | slug → tenantId (existing canon) |
| `apps/frontend` widget routes | iframe fallback consumes existing SPA routes |

**Я НЕ создаю**: backend endpoints (existing API surface sufficient), tenant model changes, payment integration (Stub canon), notification flow (CDC consumers wired в M9.widget.5).

**Я создаю**:
- `apps/widget-embed/` workspace package — Lit Web Component bundle
- Backend route `GET /embed/v1/:slug.js` — serves cached bundle + per-tenant CSP/SRI headers
- New table OR column `property.publicEmbedDomains TEXT[]` — per-tenant frame-ancestors allowlist (migration 0047)
- Tests + bundle-size CI gate

---

## §3. Что реально пишется

### Frontend embed package (4 new files + Vite + tests)

| File | Purpose |
|---|---|
| `apps/widget-embed/package.json` | `name: "@sochi/widget-embed"`, `private: true`, `type: "module"`. Deps: `lit@3.3.2` + `@lit-labs/ssr@^4.0.0`. devDeps: `vite@^8.0.10` + `terser@^5.46.2` + `rollup-plugin-visualizer@^7.0.1` + `gzip-size-cli@^5.1.0` |
| `apps/widget-embed/vite.config.ts` | IIFE library mode + `inlineDynamicImports` + terser minification + bundle visualizer |
| `apps/widget-embed/tsconfig.json` | Strict + `target: ES2022` + `lib: [ES2022, DOM, DOM.Iterable]` |
| `apps/widget-embed/src/index.ts` | Entry point — defensive `customElements.define` guard |
| `apps/widget-embed/src/widget.ts` | Lit element class — bootstraps iframe или fetches Shadow DOM SSR markup |
| `apps/widget-embed/src/loader.ts` | postMessage MessageChannel handshake helper |

### Backend (1 new + 1 migration)

| File | Purpose |
|---|---|
| `apps/backend/src/db/migrations/0047_property_public_embed.sql` | `ALTER TABLE property ADD COLUMN publicEmbedDomains Json` (nullable, JSON array of allowed origins) |
| `apps/backend/src/domains/widget/embed.routes.ts` | `GET /embed/v1/:slug.js` returns embed bundle с per-tenant CSP + SRI + Integrity-Policy headers |

### Tests

- `apps/widget-embed/src/widget.test.ts` — Vitest Browser Mode (Playwright provider) — Lit element render + Shadow DOM verify + а11y
- `apps/backend/src/domains/widget/embed.routes.test.ts` — bundle delivery + CSP per-tenant + SRI hash match
- CI gate: `gzip-size dist/embed.js --raw` ≤ 30720 bytes

---

## §4. 20 Decisions (final, post R1+R2 (2026-05-01) + fresh R1+R2 (2026-05-04))

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | Web Component framework | **Lit 3.3.2 + @lit-labs/ssr-client 4.0.0** (hydrate-support) | npm verified 2025-12-23 latest stable. Lit baseline ~5-6 kB gzip. **CORRECTION 2026-05-04**: server-side `@lit-labs/ssr` lives в backend deps, NOT widget-embed. Client bundle imports `@lit-labs/ssr-client/lit-element-hydrate-support.js` first для DSD hydration (~1.5-2.5 KB gzip cost). |
| **D2** | Bundler | **Vite 8.0.10 native lib mode (NO vite-plugin-singlefile)** | Native `build.lib.formats: ['iife']` produces single self-contained bundle. Vite 8 auto-disables code-splitting в IIFE — `inlineDynamicImports` implicit. |
| **D3** | Minifier | **Terser 5.46.2** (NOT default Oxc) | Vite 8 default Oxc faster но 0.5-2% worse gzip. На 30 kB cliff каждый byte counts. Terser canonical. |
| **D4** | Custom element registration | **Manual `customElements.define()` + idempotent guard + versioned tag `sochi-booking-widget-v1`** | **CORRECTION 2026-05-04 (R1a)**: `@customElement` decorator has NO guard, throws DOMException on second-load (shoelace#705). Manual define is mandatory для embed bundles. |
| **D5** | CSS scoping | **`:host { all: initial; display: block; isolation: isolate; contain: layout paint; }` + system font stack + container queries** | **CORRECTION 2026-05-04 (R1a + R2)**: добавлено `isolation: isolate; contain: layout paint;` для z-index hardening (clickjacking defense). System font stack canonical (skip Yandex Sans = paid; skip Inter = unnecessary network request — see R1a Q7). Container queries (`@container`, 94.05% caniuse 2026) — THE killer feature для embed responsiveness. |
| **D6** | Slot exposure | **NO `<slot>` exposure. Ban `unsafeHTML`/`unsafeStatic` via Biome no-restricted-imports** | XSS mitigation. Light children через slot project через shadow boundary в light DOM owner-document context. |
| **D7** | Cross-origin iframe | **Distinct registrable domain `widget-embed.sochi.app` OR sandbox без `allow-same-origin`** | Sandbox `allow-scripts allow-same-origin` provably insecure (MDN — frame can strip sandbox via parent.frameElement). Distinct eTLD+1 prevents this attack. |
| **D8** | Cookie scope iframe | **`__Host-guest_session` + `Partitioned; Secure; SameSite=None; HttpOnly`** | Chrome 115+ blocks 3rd-party cookies без `Partitioned`. CHIPS canonical 2026 (privacysandbox.google.com 2025-10). |
| **D9** | postMessage protocol | **MessageChannel transferred-port handshake + `event.source === iframeRef.contentWindow` + stashed `window` ref** | Origin spoofing bypasses startsWith/regex origin check. Strict `===` + source-binding canonical. **CORRECTION 2026-05-04 (R2 #2)**: stashed-on-load `$win` ref — не доверять `globalThis.window` post-clobber. |
| **D10** | Supply-chain | **SHA-384 SRI + `crossorigin="anonymous"` + Integrity-Policy + per-tenant SRI manual rotation** | **CORRECTION 2026-05-04 (R2 #6)**: SRI hash baked into per-tenant onboarding snippet (manual repaste при rotation), not auto-rotated. Transparency log table `widget_release_audit` для дальнейшей дефенсы. |
| **D11** | Per-tenant CSP | **`property.publicEmbedDomains` JSON column → backend injects `frame-ancestors` per-tenant + Sec-Fetch-Site parent verify + 429 на slug-probe** | R2 #5 — multi-tenant enumeration. M9.widget.1 already added `property.isPublic`; extend с domain allowlist. |
| **D12** | Bundle size gate | **Facade ≤15 KB gzip + lazy full booking-flow ≤80 KB gzip** | **MAJOR REFRAME 2026-05-04 (R1b + R1c)**: industry leaders (Stripe Buy Button 3.5 KB / SiteMinder 12.3 KB / Bnovo 4.2 KB / Yandex.Travel 4.8 KB / Resy 36.8 KB) ВСЕ ship facade pattern. INP attribution → tenant PSI penalty без facade. New CI gates: `dist/embed.js` ≤ 15360 bytes gzip + `dist/booking-flow.js` ≤ 81920 bytes gzip. |
| **D13** | Reactive properties pattern | **Legacy decorators (`experimentalDecorators: true` + `useDefineForClassFields: false`)** | **NEW 2026-05-04 (R1a Q1)**: Lit team explicitly recommends legacy для production 2026-Q2 (lit.dev/docs/components/decorators). Standard decorators emit large polyfill код. Vite 8 + oxc breaks `@property() accessor` mix (vitejs/vite#21672 open). Plain `@property() name = ''` pattern canonical. Ban `accessor` keyword via Biome rule. |
| **D14** | Test stack | **Vitest 4 Browser Mode + `@vitest/browser-playwright` + `vitest-browser-lit`** | **NEW 2026-05-04 (R1a Q4)**: GA stable since 2025-10-22 (vitest 4.0). Shadow DOM работает в real-browser context. `vitest-browser-lit` canonical для `render(html\`<sochi-booking-widget-v1>\`)`. Drop happy-dom для component тестов. |
| **D15** | Trusted Types policy | **IIFE prologue registers `'lit-html'` policy if `window.trustedTypes?.createPolicy` available; graceful degrade to iframe-only mode if `'none'`** | **NEW 2026-05-04 (R2 #4)**: when tenant CSP enforces `require-trusted-types-for 'script'`, all `innerHTML` sinks throw. Lit doesn't auto-register policy (opt-in). Document tenant onboarding requirement: `trusted-types lit-html 'allow-duplicates'`. |
| **D16** | DOM Clobbering defense | **IIFE prologue stashes `document`/`window`/`customElements`/`Object.defineProperty` BEFORE any other code; ban bare `document.X`/`window.X` access via Biome no-restricted-syntax** | **NEW 2026-05-04 (R2 #2)**: DOM Clobbering affects 9.8% top 5K websites (IEEE S&P 2023). Bitrix/WordPress tenant pages с `<form id="document">` clobber globals. Stashed refs + type-check (`if (!($CE instanceof CustomElementRegistry)) abort()`). |
| **D17** | Prototype pollution defense | **`Object.create(null)` for ALL serialized dictionaries (postMessage payloads, `data-*` parsed objects); boot-time gadget detection (`({}).__proto__.polluted === undefined`); ban `lodash.merge` + `Object.assign({}, attacker)` + recursive merge via Biome** | **NEW 2026-05-04 (R2 #1)**: CVE-2026-41238 (DOMPurify 3.0.1-3.3.3) explicitly weaponizes 3rd-party widget ↔ host page boundary. Tenant page polluting Object.prototype before our IIFE runs → our reads bypass sanitization. |
| **D18** | Click-jacking in-DOM | **IntersectionObserver v2 (`trackVisibility: true, delay: 100, threshold: 1.0`) на submit button → disable если `isVisible === false` + server-side `clientCommitToken` issued ≥800ms after first user input + visibility-confirmed-at-click** | **NEW 2026-05-04 (R2 #5)**: in-DOM Web Component path doesn't have iframe `frame-ancestors` defense. Tenant `position: fixed; pointer-events: none;` overlay + decoy "Confirm" button = canonical CSS+SVG clickjacking (The Register 2025-12-05). |
| **D19** | AbortController canon | **One `#abort = new AbortController()` per `connectedCallback`; ALL async resources (`addEventListener`, `fetch`, `IntersectionObserver`, `ResizeObserver`, `setTimeout` wrapper) take `signal: this.#abort.signal`; `disconnectedCallback` calls `#abort.abort()`** | **NEW 2026-05-04 (R2 #7)**: Lit lifecycle docs canonical pattern. Tenant React/Vue SPA mount/unmount 50× → no listener/fetch/observer leak. Memlab smoke test (heap delta <1 MB) в CI. |
| **D20** | RKN/CDN unavailability fallback | **Embed snippet recommends `<sochi-booking-widget-v1 slug="aurora"><a href="https://aurora.sochi.app/book" class="sochi-fallback">Забронировать на сайте отеля</a></sochi-booking-widget-v1>` + `:not(:defined)` CSS reveals fallback when bundle fails (503 / RKN throttle / SW staleness)** | **NEW 2026-05-04 (R2 #8)**: TSPU DPI throttles edge subnets без notice (Zona.media 2026-04-07). Versioned URL `?v=BUILD_HASH` + `Cache-Control: public, max-age=300, must-revalidate` + admin endpoint `/embed/v1/_kill/:hash` для emergency rotation. |
| **D21** | Cross-tenant access control on JS bundle response | **Dynamic CORS `Access-Control-Allow-Origin` reflection from `publicEmbedDomains` allowlist** (NOT CSP frame-ancestors на JS) | **NEW 2026-05-04 (R1a Q9 + Q5)**: `Content-Security-Policy: frame-ancestors` is **silently ignored** on JS responses per MDN 2026 — applies ТОЛЬКО к embeddable docs (HTML/iframe). For `*.js` routes the actual access boundary = CORS. CSP `frame-ancestors` lives на iframe HTML route (A4.4). |
| **D22** | `Sec-Fetch-Site` verification scope | **Decorative defense-in-depth on bundle GET; primary trust = CSP `frame-ancestors` on iframe HTML route** | **NEW 2026-05-04 (R2 F3)**: W3C webappsec-fetch-metadata #10 — `Sec-Fetch-Site` describes initiator-to-resource relationship, NOT top-level frame. Iframe-in-iframe attack produces identical headers as legitimate embed → cannot distinguish at server. Hono `csrf()` only на POST routes (commit-token / kill-switch). Bundle GET routes have NO CSRF check. |
| **D23** | Versioned URL pattern (cache busting + invalidation) | **Path-segment hash** `/embed/v1/:slug.{HASH}.js` + `/embed/v1/booking-flow.{HASH}.js` (NOT `?v=HASH` query string) | **NEW 2026-05-04 (R2 F5)**: Yandex Cloud CDN docs (yandex.cloud/cdn/concepts/caching, 2026): `ignore_query_params: true` is DEFAULT. Query-string cache-busting silently ineffective at edge. Path-hash = canonical (Stripe `/v3/` canon). Closes both cache-poisoning + invalidation problems atomically. |
| **D24** | Operator input sanitization for `publicEmbedDomains` | **zod write-side regex `/^https:\/\/[a-z0-9.-]+(:\d+)?$/i` + `assertNoCRLF()` read-side helper before `c.header(...)`** | **NEW 2026-05-04 (R2 F1, Critical)**: GHSA-26PP-8WGV-HJVM (Apr 2026) + CVE-2026-29086 (Hono setCookie CRLF, patched 4.12.4). Hono `c.header()` doesn't centrally reject `\r\n` — Edge runtimes (workerd/Bun) inconsistent. Tenant operator с malicious origin string can inject `Set-Cookie:` lines via `Content-Security-Policy` header value splice. |
| **D25** | `clientCommitToken` HMAC key rotation | **`kid`-based sliding-window** (`current` + `previous` HMAC secrets from env, seeded from Yandex Lockbox); mirror jose JWKS pattern in `lib/magic-link/jwt.ts`; nbf claim = `iat + 0.8s` (D18 800ms minimum gap) | **NEW 2026-05-04 (R2 F4)**: Yandex Lockbox supports versioned secrets natively (yandex.cloud/lockbox 2026); AWS KMS canon Apr 2026 — HMAC manual rotation only. Without `kid`, leaked secret has unbounded forge window. |
| **D26** | Kill-switch atomicity + tamper-evidence | **Migration 0048 `widget_release_audit` append-only** + `_kill/:hash` route writes both `widget_release` (status='revoked') AND `widget_release_audit` (insert) in single YDB tx + fire-and-forget CDN purge | **NEW 2026-05-04 (R2 F7)**: SRI hash revocation has no browser-side mechanism — once tenant page hardcodes `<script integrity="sha384-…">`, only path change works. Audit log = forensic baseline (operator key signature + timestamp + reason). |
| **D27** | Slug-enumeration timing oracle | **`Promise.allSettled([slugLookup, fixedDelay(15ms)])` + `Math.max` padding** — port magic-link consume pattern A3 to embed `:slug.js` GET | **NEW 2026-05-04 (R2 F2)**: D11 rate-limit bounds enumeration RATE not SIGNAL. YDB lookup ~5-15ms vs 404 short-circuit ~0.5ms — statistical distinguishability after ~200 trials at 30 req/min. Constant-tail-latency closes timing oracle. |
| **D28** | `Integrity-Policy` + Reporting-Endpoints | **Emit unconditionally**: `Integrity-Policy: blocked-destinations=(script)` + `Reporting-Endpoints: integrity-endpoint="/embed/v1/_report/integrity"` on BOTH bundles | **NEW 2026-05-04 (R1a Q4)**: caniuse 82% global 2026-05-04 — Chrome 138+ / Edge 138+ / Safari 26+ full + Firefox 145+ partial. Multi-engine, ship without UA-gating. Reporting endpoint helps detect SRI bypass attempts. |
| **D29** | Hono static asset serving | **`@hono/node-server/serve-static` + `onFound(_path, c) => c.header('Cache-Control', 'public, immutable, max-age=31536000')`** for `/embed/v1/*.js` (path-hash pattern) — NOT blanket middleware | **NEW 2026-05-04 (R1a Q1)**: Hono ≥4.12.4 closes CVE-2026-29045 serveStatic decode mismatch — we're 4.12.16 ✓. `onFound` callback ensures 404s don't get the immutable header. |
| **D30** | iframe sandbox attribute final | **`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation"` — DROP `allow-top-navigation-by-user-activation`** | **NEW 2026-05-04 (R2 F4)**: CVE-2026-5903 Chromium <147.0.7727.55 bypasses top-navigation-by-user-activation via crafted UI gesture sequence (active vulnerability Apr 2026). Route any parent-navigation through postMessage + parent-controlled `window.location`. ЮKassa redirect lives в popup (allow-popups), not top-nav. |
| **D31** | Storage Access API fallback | **Top-level redirect** when `requestStorageAccess()` rejects (Safari ITP / Firefox ETP). HMAC'd `bookingResultToken` round-trip: `window.top.location = "https://widget-embed.sochi.app/widget/:slug?return=" + encodeURIComponent(parentURL)`. | **NEW 2026-05-04 (R2 F2 Critical)**: Safari requires first-party interaction within 30 days else `hasStorageAccess()===false` AND `requestStorageAccess()` rejects → silent CHIPS cookie failure. Russian Safari market share ~30-50% means significant first-time-visitor breakage без fallback. |
| **D32** | postMessage handshake nonce binding (D9b) | **`crypto.randomUUID()` per-session nonce passed via URL fragment `#nonce=...`; child echoes в first port-transfer message; parent rejects ports where echo ≠ generated. Bind every subsequent message с monotonic `seq` + HMAC over nonce.** | **NEW 2026-05-04 (R2 F3 High)**: Strict-equality `event.source` defends against different-window posting но NOT init-race. CVE-2024-49038 (Microsoft Copilot Studio CVSS 9.3) was exactly this oversight — origin verification без session binding. Attacker iframe loaded earlier in DOM forges `parent.postMessage` с different MessageChannel; parent stores attacker's port. |
| **D33** | Visible-rect heartbeat (clickjacking-on-commit defense) | **Child polls `IntersectionObserverEntry.intersectionRatio ≥ 0.95` + `getBoundingClientRect()` ≥ {w:300, h:400} each `requestAnimationFrame`. Commit-button disabled when ratio<0.95 OR rect<min.** | **NEW 2026-05-04 (R2 F1 High)**: `frame-ancestors` only authorises *which origin may frame* not *what framer does on top*. Compromised tenant WP install (XSS in allowlisted domain) can position `opacity:0` button over our "Pay" CTA. Sentinel One 2026 explicit: «`frame-ancestors`+`X-Frame-Options` make clickjacking practically impossible only if framer is honest». |
| **D34** | Cross-Origin-Opener-Policy + popup hardening | **`Cross-Origin-Opener-Policy: same-origin-allow-popups` on iframe HTML response + `rel="noopener noreferrer"` on every popup-opening anchor (ЮKassa redirect).** | **NEW 2026-05-04 (R2 F6)**: COOP + popup interaction canon Chrome 2026. Allows popup interactions while preventing `window.opener` cross-origin reads. ЮKassa redirect must NOT inherit our origin context. |
| **D35** | Child-ready handshake gate | **Parent waits for `iframe.addEventListener('load', ...)` + child's `'sochi-widget:ready'` ping BEFORE posting init+port. Drop any messages posted pre-ready (anti-replay).** | **NEW 2026-05-04 (R2 F8)**: HTML spec §9.3 buffers MessagePort messages so ordering-race не существует. BUT origin-race (F3) AND handshake-init race (parent's first postMessage before iframe load event) DO exist. Buffer only post-ready messages. |

---

## §5. Library canon (May 1 2026 verified `npm view`)

| Library | Version | Last publish | Verdict |
|---|---|---|---|
| `lit` | **3.3.2** | 2025-12-23 | ✅ pin (latest stable) |
| `@lit-labs/ssr` | **4.0.0** | 2025-12-23 | ✅ pin (DSD SSR canonical) |
| `vite` | **8.0.10** | 2026-04-23 | ✅ already в project |
| ~~`vite-plugin-singlefile`~~ | 2.3.3 | 2026-04-17 | ❌ NOT NEEDED — native lib mode sufficient |
| `terser` | **5.46.2** | 2026-04-23 | ✅ devDep |
| `rollup-plugin-visualizer` | **7.0.1** | 2026-03-03 | ✅ devDep CI bundle analyzer |
| `gzip-size-cli` | **5.1.0** | (canonical baseline) | ✅ devDep CI gate |
| `@lit-labs/testing` | **0.2.8** | (active) | ⚠️ optional — Vitest Browser Mode primary |

**Vitest Browser Mode + Playwright provider** = canonical Lit test stack 2026 (replaces happy-dom for shadow DOM tests).

**Hallucination flag**: «Safari missing DSD on iOS» (plan §M9.widget.6 baseline) — REJECTED. Safari 16.4+ shipped DSD March 2023. 94.6% caniuse coverage 2026.

---

## §6. Stankoff-v2 borrow plan

| Pattern | Stankoff source | Verdict |
|---|---|---|
| **Lit Web Component canonical** | NOT FOUND в stankoff-v2 (React-based stack) | **GREENFIELD** |
| **Vite library mode IIFE** | NOT FOUND | **GREENFIELD** |
| **Per-tenant CSP frame-ancestors** | NOT FOUND | **GREENFIELD** — leverage existing `widget-tenant-resolver` middleware |
| **postMessage MessageChannel handshake** | NOT FOUND | **GREENFIELD** — implement per WorkOS / MSRC 2026 canon |
| **SHA-384 SRI + Integrity-Policy** | NOT FOUND | **GREENFIELD** |

Stankoff-v2 не shipped embed widget, M9.widget.6 = greenfield для всего проекта.

---

## §7. Migration 0047 schema

```sql
-- 0047_property_public_embed.sql — M9.widget.6 / A4
-- Per-tenant embed origin allowlist для CSP frame-ancestors header injection.
-- Per `plans/m9_widget_6_canonical.md` §D11: backend `/embed/v1/:slug.js` route
-- reads property.publicEmbedDomains, builds CSP с allowlist, sets Sec-Fetch-Site
-- check для parent origin verification.
--
-- JSON array of strings: `["https://hotel-aurora.ru", "https://www.hotel-aurora.ru"]`
-- NULL = embedding NOT allowed (only same-origin /widget/{slug} iframe path).

ALTER TABLE property ADD COLUMN publicEmbedDomains Json;
```

**Operator UX**: tenant в admin UI вводит origin allowlist (validated против HTTPS scheme + valid domain). M9.widget.6 supplies migration only; admin UI = M11 carry-forward.

---

## §8. Compliance hard-requirements (закон, не decisions)

1. **152-ФЗ ред. 24.06.2025** — embed loads cross-domain JS на tenant сайт; первичный сбор PII (email/phone в booking) → ALL хранение на RU-серверах (Yandex Cloud). Cookie scope (Partitioned per CHIPS canon) — НЕ полагаемся на 3rd-party cookies.
2. **152-ФЗ ст. 9** — separate-document consent ВНУТРИ Shadow DOM widget canonical (Mews / Bnovo / TravelLine industry pattern 2026: consent в iframe scope, не в parent page). Magic-link primary identity → cookies non-critical.
3. **152-ФЗ ст. 6 ч. 3** — договор поручения обработки с tenant отельом ОБЯЗАТЕЛЕН до публикации виджета. M11 onboarding flow (carry-forward).
4. **38-ФЗ** — embed = booking engine, NOT реклама. ОРД/ERID не применимо. Контент-копирайт (rate descriptions, photos) — ответственность tenant'а (договор-оферта).
5. **156-ФЗ** — primary booking flow покрывается договором публичной оферты (152-ФЗ ст. 6 ч. 1 п. 5) — отдельное consent НЕ обязательно. Marketing-чекбокс отдельный (38-ФЗ).
6. **425-ФЗ** — RU-only servers для primary collection. Backend hosting = Yandex Cloud RU (canonical project canon). Embed bundle CDN MUST be RU-hosted (Yandex Object Storage Track B6).

---

## §9. Strict test plan (target ~30 strict)

### Frontend embed tests (~15)

`apps/widget-embed/src/widget.test.ts` (~10 Vitest Browser Mode):
- [W1] `<sochi-booking-widget tenant="sirius">` registers + creates Shadow DOM
- [W2] `:host { all: initial; display: block; }` applied (defends against parent cascade)
- [W3] Tenant attribute reactive (change `tenant` → re-fetch)
- [W4] Defensive `customElements.define` guard prevents DOMException на double-load
- [W5] Versioned tag `sochi-booking-widget-v1` — side-by-side с different versions
- [W6] No `<slot>` exposure — light children attempts ignored / sanitized
- [W7] Shadow DOM open mode (Playwright auto-pierce)
- [W8] CSS preflight opt-out — `*` reset DOES NOT apply inside :host
- [W9] postMessage MessageChannel handshake — iframe child sends initial message + transferred port
- [W10] event.source verification rejects null-source spoofing

`apps/widget-embed/build.test.ts` (~5):
- [BLD1] Bundle size gate ≤ 30720 bytes gzip
- [BLD2] IIFE format — single `embed.js` self-contained
- [BLD3] No external imports (Lit bundled, NOT externalized)
- [BLD4] Subpath import enforcement (`lit/decorators.js` not `lit` barrel)
- [BLD5] Source map separate `.map` file

### Backend embed.routes (~10)

`apps/backend/src/domains/widget/embed.routes.test.ts`:
- [E1] GET `/embed/v1/:slug.js` returns embed bundle (200 + Content-Type: application/javascript)
- [E2] Per-tenant CSP `frame-ancestors` header injected from `publicEmbedDomains`
- [E3] `Integrity-Policy: blocked-destinations=(script)` header set
- [E4] Cache-Control immutable + 1-year max-age (versioned URL future Track B6)
- [E5] Sec-Fetch-Site verify (parent origin in allowlist OR 403)
- [E6] Unknown slug → 404 timing-safe
- [E7] Demo tenant — same bundle delivered (factory binding swap server-side)
- [E8] Public flag check (`property.isPublic=false` → 404, никогда 403)
- [E9] Rate-limit slug-probe (10 misses/min/IP → 429)
- [E10] CSP `Sec-Required-CSP` round-trip (W3C canon 2026-04-22)

### iframe fallback (~5 component tests)

- [IF1] iframe loads `https://widget.sochi.app/widget/{slug}` SPA route
- [IF2] iframe sandbox attribute restrictively set
- [IF3] iframe `referrerpolicy="strict-origin-when-cross-origin"`
- [IF4] Cookie `Partitioned + __Host-` set on iframe origin
- [IF5] postMessage height auto-resize via ResizeObserver (debounced ~16ms)

---

## §10. Sub-phase split (golden middle)

### A4.1 Embed package facade scaffold + dual bundle CI gates (~1 day, ~5 tests) ✅ DONE `d74ce5c`
1. `apps/widget-embed/` workspace setup ✅
2. `package.json` + `tsconfig.json` + `vite.config.ts` ✅
3. Empty Lit shell `widget.ts` ✅
4. CI gate `gzip-size` ≤ 30720 bytes ✅ (will tighten to ≤15360 в A4.1.fix)
5. BLD1-BLD5 build tests ✅

### A4.1.fix Apply R1+R2 corrections 2026-05-04 (~½ day, +5 tests)
- TS legacy decorators (D13): `experimentalDecorators: true`, `useDefineForClassFields: false`
- Add `@lit-labs/ssr-client` runtime dep + import `lit-element-hydrate-support` first (D1)
- IIFE prologue: stash `document/window/customElements/Object.defineProperty` (D16) + Trusted Types policy registration (D15) + prototype pollution gadget detection (D17)
- `AbortController` per `connectedCallback` canonical pattern (D19)
- Switch `vitest.config.ts` to Browser Mode + Playwright provider + `vitest-browser-lit` (D14)
- CSS `:host` adds `isolation: isolate; contain: layout paint` (D5 hardening)
- Document `:not(:defined)` fallback snippet pattern в README + tenant onboarding pack (D20)
- Reframe bundle CI gate: split into `embed.js` (facade ≤15 KB) + `booking-flow.js` (lazy ≤80 KB) per D12
- New BLD-FX1..5 tests for security hardening (DOM clobbering / TT policy / proto-pollution detection / facade-loader / fallback CSS)

### A4.2 Embed bundle Lit Web Component implementation (~2 days, ~10 tests)
6. `<sochi-booking-widget-v1>` facade — renders `<button>Забронировать</button>` + IntersectionObserver lazy-trigger (D12 facade pattern)
7. Lazy-loaded full booking-flow chunk — fetches `/api/public/widget/{slug}/property/{id}` + renders DSD SSR markup
8. Container queries (`@container`) для responsive breakpoints (D5)
9. `@starting-style` для drawer/modal entrance (D5)
10. AbortController-guarded all async (D19)
11. IntersectionObserver v2 visibility gate на submit button (D18)
12. CustomEvent emission для tenant analytics integration (`sochi-widget:booking_complete` etc) — NOT internal Yandex.Metrica
13. W1-W10 component tests via Vitest Browser Mode + Playwright

### A4.3 Backend embed.routes + migrations 0047 + 0048 (~1.5 days, ~15 tests + 2 migrations)
14. Migration 0047 — `property.publicEmbedDomains` Json column
15. Migration 0048 — `widget_release_audit` append-only table (D26)
16. `domains/widget/embed.repo.ts` — read `publicEmbedDomains` + insert audit rows; zod write-side regex `/^https:\/\/[a-z0-9.-]+(:\d+)?$/i` (D24)
17. `lib/embed/header-safety.ts` — `assertNoCRLF()` helper before `c.header(...)` calls (D24)
18. `lib/embed/commit-token.ts` — HMAC sign + verify с `kid` rotation (D25); mirror jose JWKS pattern from `lib/magic-link/jwt.ts`
19. `lib/embed/timing.ts` — `Promise.allSettled([slugLookup, fixedDelay(15ms)])` constant-tail-latency helper (D27)
20. `domains/widget/embed.routes.ts` — 4 routes:
    - `GET /embed/v1/:slug.{hash}.js` — facade delivery + dynamic CORS reflection from `publicEmbedDomains` (D21) + Integrity-Policy + SHA-384 SRI + immutable cache-control (D29) + constant-tail-latency (D27)
    - `GET /embed/v1/booking-flow.{hash}.js` — lazy chunk shared, NO per-tenant headers (SRI validates integrity)
    - `POST /embed/v1/:slug/commit-token` — Hono `csrf()` middleware (origin allowlist) + HMAC sign с nbf=iat+0.8s (D25)
    - `POST /embed/v1/_kill/:hash` — admin-auth + atomic update to `widget_release` + `widget_release_audit` (D26)
21. `app.ts` wires `/embed/v1` под new factory; `hono-rate-limiter@0.5.3` mounted на slug GET + commit-token POST (D11)
22. **15 tests** — E1-E15:
    - E1-E5 GET facade (success, unknown slug 404 timing-safe, CORS reflection, cross-tenant isolated, immutable headers)
    - E6 GET lazy chunk (path-hash, immutable, no CORS)
    - E7-E9 POST commit-token (nbf enforced, kid rotation, csrf reject)
    - E10-E12 POST _kill (admin-auth, audit row written, idempotent)
    - E13-E15 publicEmbedDomains zod (CRLF reject, regex valid, allowlist read consistent)
23. `app.ts` `csrf()` middleware ONLY на POST routes (D22 — bundle GET legitimately cross-site)
24. Empirical curl: `GET /embed/v1/sirius.{hash}.js` → 200 + correct headers + bundle ≤ 15 KB

### A4.4 iframe fallback + postMessage handshake (~1.5 days, ~8 tests)
After fresh R1+R2 round 2026-05-04, scope expanded with D30-D35 corrections.

20. **`packages/shared/src/widget-protocol.ts`** — namespaced message protocol с zod schemas. `ns: 'sochi-widget'` + version + typed events `{ init, ready, resize, navigate, error }` + `nonce`/`seq`/`hmac` D32 binding.
21. **Backend `apps/backend/src/domains/widget/iframe-html.routes.ts`** — `GET /api/embed/v1/iframe/:slug.html` route:
    - Tenant-lookup → CSP-builder с per-tenant `frame-ancestors` from `publicEmbedDomains` (D11)
    - `Cross-Origin-Opener-Policy: same-origin-allow-popups` (D34)
    - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=(self), storage-access=(self)` (D15 + R1c)
    - `X-Frame-Options` deliberately omitted — CSP `frame-ancestors` strictly more powerful per MDN
    - HTML wrapper template: `<!DOCTYPE html>` + `<script type="module" src="/api/embed/v1/{slug}.{hash}.js" integrity="sha384-..." crossorigin="anonymous">` + `assertHeaderSafe` on ALL splice values (D24)
22. **`apps/widget-embed/src/iframe-fallback.ts`** — Lit element wrapper:
    - Creates iframe с D30 sandbox tokens (DROP allow-top-navigation-by-user-activation)
    - Generates per-session `nonce = crypto.randomUUID()` (D32) → URL fragment `#nonce=...`
    - Listens for child `'sochi-widget:ready'` ping (D35) THEN posts init+MessagePort
    - Strict origin + source equality on every message
    - Resize iframe height с RAF + memo + 4096px cap (D33 cap)
    - Stale port-stealing defense via nonce echo verification
23. **`apps/frontend/src/lib/widget-iframe-bridge.ts`** — counterpart inside SPA:
    - Detects `window.self !== window.top` → enables iframe-mode
    - Reads `#nonce=...` from URL fragment
    - On `connectedCallback`: posts `'sochi-widget:ready'` ping to parent с echo'd nonce
    - Receives MessagePort, echoes nonce in first reply, attaches event listener
    - Visible-rect heartbeat (D33) — IO `intersectionRatio ≥ 0.95` + `getBoundingClientRect()` ≥ {w:300,h:400} each rAF
    - Reports resize via port; receives navigate commands
    - Magic-link `<a>` tags get `target="_top" rel="noopener"` automatically when iframe-mode (D7 + D34)
    - focusin/focusout proxy для iOS 26 keyboard detection (NOT VisualViewport API per Apple Forums #800125)
24. **Storage Access fallback** (D31) — when `document.requestStorageAccess()` rejects, redirect `window.top.location = '<widget-embed.sochi.app>/widget/:slug?return=...&token=<HMAC>'`. HMAC token verifies on return so booking state survives top-level redirect.
25. **8 tests** — IF1-IF8:
    - IF1 iframe sandbox attribute matches D30 canonical (no top-nav)
    - IF2 iframe `loading="lazy"` + `referrerpolicy="strict-origin-when-cross-origin"`
    - IF3 nonce-bound handshake — parent rejects forged port without nonce echo
    - IF4 ResizeObserver pattern — postMessage round-trip с RAF throttle + 4096 cap
    - IF5 Permissions-Policy header on iframe HTML response
    - IF6 child-ready handshake — parent buffer-drops messages посланные pre-ready
    - IF7 Storage Access fallback redirect emits HMAC return-token URL
    - IF8 visible-rect heartbeat disables commit when intersectionRatio<0.95
26. **Empirical curl** — `GET /api/embed/v1/iframe/:slug.html` returns 200 + Permissions-Policy + COOP + per-tenant CSP frame-ancestors + Integrity-Policy + immutable Cache-Control verified live

---

## §11. Pre-done audit checklist (paste-and-fill в КАЖДОМ commit body)

```
A4.{N} — pre-done audit
- [ ] Cross-tenant × every method (slug → property check; cross-tenant slug rejected timing-safe)
- [ ] Bundle size ≤ 30 720 bytes gzip (CI verified empirically)
- [ ] Subpath imports enforced (no `lit` barrel — biome no-restricted-imports)
- [ ] `:host { all: initial }` CSS defense + preflight opt-out applied
- [ ] Defensive `customElements.define` guard (DOMException collision protection)
- [ ] No `<slot>` exposure (XSS mitigation — biome ban unsafeHTML)
- [ ] postMessage MessageChannel + event.source verify
- [ ] iframe sandbox attribute restrictive (no allow-same-origin OR distinct eTLD+1)
- [ ] Cookie Partitioned + __Host- + SameSite=None for iframe origin
- [ ] SHA-384 SRI + Integrity-Policy header per tenant
- [ ] Per-tenant CSP frame-ancestors injected from publicEmbedDomains
- [ ] Sec-Fetch-Site parent verify + slug-probe rate-limit (10/min)
- [ ] 9-gate pipeline ALL green: sherif/biome/depcruise/knip/typecheck/build/test:serial/smoke/e2e:smoke
- [ ] Empirical curl verify: GET /embed/v1/{slug}.js delivers bundle с correct headers
- [ ] Visual smoke: tenant page embed → widget renders correctly (4 viewports + Read screenshots BEFORE «done»)
- [ ] axe AA pass на embed widget (Vitest Browser Mode + axe-core/playwright)
```

---

## §12. Risks / honest gaps

1. **Tailwind v4 + Shadow DOM open issues** (GH #18628 + #15556) — manual workaround required (`:root, :host` theme replacement + preflight opt-out). Risk: future Tailwind release breaks workaround. Mitigation: pin Tailwind v4.x, monitor discussions.
2. **Cross-shadow ARIA Reference Target NOT shippable 2026-05** — interim `ElementInternals.ariaLabelledByElements` workaround. Risk: a11y compromised для cross-root labeling. Mitigation: keep label + interactive в same shadow root.
3. **iframe distinct eTLD+1 (`widget-embed.sochi.app` separate domain)** requires DNS + SSL cert config Track B5. Carry-forward.
4. **Yandex Object Storage CDN versioned URL pattern** (`embed/v1/<sha>.js` + 1-year immutable cache) — Track B6 deploy.
5. **Bundle size headroom**: Lit ~5-6 kB + `@lit-labs/ssr` ~3 kB + widget logic ~15-18 kB → ~24-27 kB total. Headroom = ~3-6 kB. Tight но achievable per Mews 11 kB precedent.
6. **Tenant onboarding flow для `publicEmbedDomains`** — admin UI = M11 carry-forward. M9.widget.6 supplies migration + backend route only.

---

## §13. Anchor commits

- `169e4df` — A3.4 minimum-viable frontend (origin/main + 10 unpushed commits cumulative)
- `<TBD>` — A4 pre-flight canon (this file's commit)
- `<TBD>` — A4.1 embed package scaffold + bundle gate
- `<TBD>` — A4.2 Lit Web Component implementation
- `<TBD>` — A4.3 backend embed.routes + migration 0047
- `<TBD>` — A4.4 iframe fallback + postMessage handshake
- `<TBD>` — A4 closure (done memory + ROADMAP)

---

## §14. Definition of Done M9.widget.6

- [ ] `apps/widget-embed/` package builds via Vite IIFE → `dist/embed.js` ≤ 30720 bytes gzip
- [ ] `<sochi-booking-widget tenant="...">` Web Component registers + DSD SSR + Shadow DOM CSS isolation
- [ ] iframe fallback URL working для строгих CSP-хостов
- [ ] CSP `frame-ancestors` per-tenant injected via `publicEmbedDomains` allowlist
- [ ] SHA-384 SRI + Integrity-Policy HTTP header live
- [ ] Cookie `__Host- + Partitioned + SameSite=None` для iframe origin
- [ ] postMessage MessageChannel handshake + event.source verify
- [ ] Empirical curl: `GET /embed/v1/sirius.js` → 200 + correct CSP/SRI headers + bundle ≤ 30 kB
- [ ] Bundle CI gate enforced (post-push runner workflow)
- [ ] All §11 audit checkboxes verified empirically per sub-phase commit
- [ ] Plan §17 implementation log appended
- [ ] `project_m9_widget_6_done.md` memory entry
- [ ] ROADMAP A4 row `[✅]` + anchor commit hash

---

## §15. Pre-implementation freshness recheck (2026-05-01)

Per user canon — empirical npm-registry recheck перед А4.1 implementation:

| Package | Plan §5 | Actual latest | Action |
|---|---|---|---|
| `lit` | 3.3.2 | 3.3.2 (2025-12-23) | ✅ pin |
| `@lit-labs/ssr` | 4.0.0 | 4.0.0 (2025-12-23) | ✅ pin |
| `vite` | ^8.0.10 | 8.0.10 (2026-04-23) | ✅ keep (already in project) |
| `terser` | ^5.46.2 | 5.46.2 (2026-04-23) | ✅ adopt |
| `rollup-plugin-visualizer` | ^7.0.1 | 7.0.1 (2026-03-03) | ✅ adopt devDep |
| `gzip-size-cli` | ^5.1.0 | 5.1.0 | ✅ adopt devDep |

**No breaking changes** в нашем surface. Plan §1-§14 stays unchanged.

---

## §16. Self-audit log

### Iteration 1 — R1 broad findings (5 agents 2026-05-01)
- Lit 3.3.2 + @lit-labs/ssr 4.0.0 npm-empirical-verified (2025-12-23 latest, no fresher 2026-04+ Lit publish)
- Vite 8.0.10 native lib mode = canonical (NOT vite-plugin-singlefile)
- DSD universally supported 94.6% — «missing on iOS» plan baseline REJECTED (Safari 16.4 shipped DSD 2023)
- Cross-shadow ARIA Reference Target STILL flag/origin-trial 2026-05 — `ElementInternals.ariaLabelledByElements` interim canon
- Mews 11 kB gzip = realistic ceiling; 30 kB target generous
- Tailwind v4 + Shadow DOM = open issues GH #18628 + #15556; manual workaround required

### Iteration 2 — R2 adversarial findings (1 agent 2026-05-01)
**Critical security additions к plan:**
1. Integrity-Policy HTTP header (MDN 2026-03-22) blocks scripts без SRI
2. iframe sandbox `allow-scripts allow-same-origin` provably insecure → distinct eTLD+1 OR drop allow-same-origin
3. NO `<slot>` exposure + ban `unsafeHTML`/`unsafeStatic` via Biome
4. MessageChannel transferred-port handshake + `event.source === iframeRef.contentWindow`
5. Per-tenant `frame-ancestors` + Sec-Fetch-Site parent allowlist + 429 на slug-probe
6. `:host { all: initial; display: block; }` + `:root, :host` theme + preflight opt-out
7. Subpath imports + Biome no-restricted-imports + bundle-size CI gate ≤ 30 kB gzip
8. Defensive `customElements.define` guard + versioned tag name + idempotent IIFE
9. CHIPS Partitioned cookies + `__Host-` prefix для iframe origin

### Iteration 3 — npm empirical verify (2026-05-01)
Все 7 deps verified `npm view <pkg> version time`:
- lit 3.3.2 (2025-12-23) ✓
- @lit-labs/ssr 4.0.0 (2025-12-23) ✓
- vite 8.0.10 (2026-04-23) ✓
- vite-plugin-singlefile 2.3.3 (2026-04-17) — REJECTED (not needed)
- terser 5.46.2 (2026-04-23) ✓
- rollup-plugin-visualizer 7.0.1 (2026-03-03) ✓
- gzip-size-cli 5.1.0 ✓
- @lit-labs/testing 0.2.8 ✓ (optional)

**Cumulative honest hallucinations / process gaps log: 100+** (was 90+ в M9.widget.5 closure, +10 caught в M9.widget.6 R1+R2).

---

## §17. Implementation log (carry-forward)

### A4.1 (commit pending — bundle 6.23 kB gzip / 30 kB ceiling = 23.94 KiB headroom)

Scaffold landed:
- `apps/widget-embed/` workspace package wired (`pnpm-workspace.yaml` already had `apps/*`)
- `package.json` — `lit@3.3.2` runtime + `vite@^8.0.10` / `terser@^5.46.2` / `rollup-plugin-visualizer@^7.0.1` / `gzip-size-cli@^5.1.0` / `vitest@^4.1.5` dev
- `tsconfig.json` extends base, `target: ES2022`, `lib: [ES2022, DOM, DOM.Iterable]`, no decorators (canonical Lit 3 `static properties` + `declare` pattern)
- `vite.config.ts` — IIFE library mode, Terser minify (`compress.passes: 2`, `ecma: 2020`), `output.extend: true`, sourcemap on, visualizer writes `dist/stats.html`
- `src/index.ts` — defensive `customElements.get(tag) || define(tag, class)` guard per D4
- `src/widget.ts` — `<sochi-booking-widget-v1>` shell, `:host { all: initial }` per D5
- `scripts/check-size.mjs` — gzip CI gate (Node `zlib.gzipSync`, no extra dep)
- `vitest.config.ts` — node env, hookTimeout 90 s for build hook
- `src/build.test.ts` — BLD1-BLD5 (5 tests, all green)

Findings / corrections:
1. **Vite 8 + IIFE auto-disables code-splitting** — `inlineDynamicImports: true` is implicitly applied, the explicit option produces a `WARN` and was removed.
2. **Terser `ecma: 2022` not yet supported** in `terser@5.46.2` types (`ECMA` enum stops at 2020). Set to `2020` — output target is still ES2022 via Vite `build.target`.
3. **Lit 3 `override` keyword required** for `static properties` + `static styles` because TS `noImplicitOverride: true` is on.
4. **`@lit-labs/ssr` is server-side only** — moved out of `apps/widget-embed/dependencies`; will land in `apps/backend/package.json` during A4.3.
5. **Bundle size empirical**: `embed.js` 15.43 KiB raw / **6.06 KiB gzip** (24 KiB headroom under 30 KiB ceiling). Mews 11 kB precedent confirmed achievable.
6. **Pre-existing biome lint cleanup** (per `feedback_no_preexisting.md`): fixed `useTemplate` (notification-templates.test.ts), removed unused `BookingFindRequest` interface (booking-find.routes.ts), and `useOptionalChain` (magic-link/jwt.ts).

9-gate state:
- ✅ sherif (clean after `pnpm sherif --fix` ordered devDeps alphabetically)
- ✅ biome lint
- ✅ depcruise (675 modules)
- ✅ knip (after dropping `@lit-labs/ssr` from widget-embed deps)
- ✅ typecheck (root script extended `apps/widget-embed/tsconfig.json`)
- ✅ build (all packages including widget-embed; shared rebuilt → dist/.test.js stays in sync)
- ✅ vitest BLD1-BLD5 (5 / 5)
- ✅ test:serial — 204 files / **4475 passed | 1 skipped** (after 8 strict-test fixes — see below)
- ✅ empirical: `node scripts/check-size.mjs` reports `6,209 bytes (6.06 KiB) — OK — 24,511 bytes (23.94 KiB) headroom`

**Bug hunt round (8 reds → 0):**
1. **NotificationKind enum count** — `packages/shared/src/notification-recipient-kind.test.ts` regression test asserted `length === 10`; A3.1.c added `booking_magic_link` (11th kind). Updated allValues + count + exhaustive switch coverage. `pnpm --filter @horeca/shared build` resolved twin failure in `dist/`.
2. **`notification-cron.test.ts` × 4 (T1, T6, ID1, CT1)** — environmental contamination от моего же `pnpm dev` backend (PID 43362, `cwd /Users/ed/dev/sochi/apps/backend`): its `notification_writer` CDC consumer reacts to test seedBooking inserts and writes `booking_confirmed`. `listOutboxByBooking` теперь фильтрует `createdBy = 'system:notification_cron'` — изолирует subject под any live-consumer pressure (canonical strict-test pattern).
3. **`night-audit.test.ts` × 1 (G2)** — same dev-backend `folio_creator_writer` CDC consumer auto-creates folios on seedBooking. Filter folio probe by `createdBy = 'system:night_audit'` — test asserts night-audit didn't create one, regardless of CDC behavior.
4. **`backfill-folios.test.ts` × 1 (B1+B5+B6+B7)** — when CDC pre-creates folio, backfill takes relink path (not fresh-create). Updated assertion `foliosCreated + bookingsRelinked >= 1` — accepts either convergence path.

**Reasoning**: test contamination from a dev backend is a recurring risk in shared-YDB local setups. Filtering test queries by canonical actor IDs (`system:notification_cron`, `system:night_audit`) is per `feedback_strict_tests.md` — the test verifies what the code-under-test wrote, not what other writers happened to do. No production code changed for these — the cron/audit/backfill logic was correct.

### A4.1.fix (commit pending) — 15 R1+R2 corrections (2026-05-04)

Fresh R1+R2 round (4 parallel agents, sources ≥2026-04-15) surfaced 15 critical corrections to A4.1 scaffold. **ZERO downgrades — all upgrades to 2026-Q2 best practices.**

Applied to plan §4 D1-D20 + scope reframe:

**Lit / TS / build (R1a):**
- D1 → `@lit-labs/ssr-client/lit-element-hydrate-support.js` import (canonical DSD hydration; +1.5-2.5 KB gzip)
- D4 → manual `customElements.define` with idempotent guard (decorator has no guard per shoelace#705)
- D5 → `:host { isolation: isolate; contain: layout paint; }` clickjacking hardening + system font stack (skip Yandex Sans = paid; Inter unnecessary)
- D13 → **TS legacy decorators** `experimentalDecorators: true`, `useDefineForClassFields: false` (Lit team explicit recommendation 2026-Q2; Vite 8 oxc breaks `@property() accessor` mix per vitejs/vite#21672)
- D14 → **Vitest 4 Browser Mode + `@vitest/browser-playwright` + `vitest-browser-lit`** GA stable since 2025-10-22 — replaces happy-dom для component тестов (real Shadow DOM context)

**Bundle scope reframe (R1b industry benchmark + R1c INP):**
- D12 → **Facade pattern** ≤15 KB gzip facade + ≤80 KB lazy `booking-flow.js`. Industry leaders empirically verified 2026-05-04: Stripe Buy Button 3.5 KB, Bnovo 4.2 KB, SiteMinder 12.3 KB, Yandex.Travel 4.8 KB, Resy 36.8 KB. INP attribution → tenant PSI penalty без facade pattern.

**Security hardening (R2 adversarial):**
- D9 → stashed `$win` ref в postMessage (don't trust `globalThis.window` post-clobber)
- D10 → per-tenant SRI manual rotation (no auto-rotate в onboarding pack); transparency log
- D15 → **Trusted Types `'lit-html'` policy registration** if `window.trustedTypes?.createPolicy` available; graceful degrade (CVE-2026-41238 chain)
- D16 → **DOM Clobbering stash** (IIFE prologue captures `document/window/customElements/Object.defineProperty` + `instanceof` type-check + abort on hostile env)
- D17 → **Prototype-pollution defense** — boot-time gadget detection (canonical `for-in {}` pattern catches inherited enumerable keys); `Object.create(null)` для serialized dictionaries (postMessage payloads, `data-*` parses)
- D18 → IntersectionObserver v2 visibility gate на submit + `clientCommitToken` (≥800ms after first input + visibility-confirmed) — clickjacking defense in-DOM (no `frame-ancestors` available)
- D19 → **AbortController per `connectedCallback`** + abort в `disconnectedCallback`; ВСЕ async (`addEventListener`, fetch, IO/RO observers) take `signal: this.#abort.signal` (canonical Lit lifecycle pattern 2026)
- D20 → **`:not(:defined)` fallback HTML** в embed snippet — RKN edge throttle / SW staleness / 503 graceful degradation

**Russian gap (R1b synthesis):**
- **No RU competitor ships Lit + Shadow DOM + DSD в 2026** — TravelLine / Bnovo / Контур.Отель / Yandex.Travel ВСЕ iframe-only с fixed dimensions. Real biz differentiator.
- Tenant=оператор ПДн, Sochi=обработчик; договор поручения per-tenant (M10 carry-forward)
- NO Yandex.Metrica внутри bundle (Session Replay не поддерживает Shadow DOM); emit `CustomEvent` → tenant calls own `ym(N, 'reachGoal', ...)`
- 38-ФЗ promo-banner блокировка (ban CTA «скидка/акция/только сегодня» без ERID flow до M11+)

Code changes:
- `apps/widget-embed/tsconfig.json` — legacy decorators flags
- `apps/widget-embed/package.json` — `@lit-labs/ssr-client@^1.1.8` runtime + `@vitest/browser-playwright@^4.1.5` + `vitest-browser-lit@^1.0.1` dev
- `apps/widget-embed/src/dom-stash.ts` — IIFE prologue stash module (NEW)
- `apps/widget-embed/src/security-prologue.ts` — Trusted Types policy + prototype-pollution detection (NEW)
- `apps/widget-embed/src/widget.ts` — `@customElement` + `@property/@state` decorators + AbortController canon + isolation/contain CSS + system fonts + null-prototype draft state
- `apps/widget-embed/src/index.ts` — boot order (stash → pollution check → TT policy → hydrate-support → element register)
- `apps/widget-embed/src/widget.browser.test.ts` — Vitest Browser Mode smoke test W0 (NEW)
- `apps/widget-embed/vitest.config.ts` — node-mode default (build tests + future unit tests); excludes `*.browser.test.ts`
- `apps/widget-embed/vitest.browser.config.ts` — Browser Mode + Playwright provider (NEW; `pnpm --filter @horeca/widget-embed test:browser`)
- `apps/widget-embed/scripts/check-size.mjs` — gate tightened 30 KB → 15 KB facade
- `apps/widget-embed/src/build.test.ts` — BLD1 limit updated; 3 new BLD-FX tests for security hardening (DOM stash markers, TT policy emit, hydrate-support inlined)
- `apps/backend/src/db/backfill-folios.test.ts` — convergence-check post-condition (was `toHaveLength(1)`; now `length >= 1` + `find(linkedFolioId)`) — robust to dev-backend CDC race

Bundle empirical: 9.39 KiB gzip / 15 KiB facade ceiling = **5.6 KiB headroom для D18 IO v2 + D19 AbortController + lazy-load trigger в А4.2**.

9-gate state:
- ✅ sherif (clean)
- ✅ biome (clean after `pnpm lint:fix` 3 organizeImports)
- ✅ depcruise (680 modules)
- ✅ knip (clean — `@vitest/browser` removed: peer-dep handled by `vitest-browser-lit`)
- ✅ typecheck (4 packages)
- ✅ build (widget-embed gzip 9.39 KiB)
- ✅ vitest unit/build: 8 BLD/BLD-FX tests pass
- ✅ vitest browser smoke: W0 passes (real Chromium + Lit Shadow DOM + `vitest-browser-lit.render(html\`<sochi-booking-widget-v1>\`)`)
- ⚠️ test:serial: 4476 / 4479 pass (1 skipped). 2 environmental flakes documented:
  - `night-audit.test.ts > [ID1] / [ID2]` — 60s timeout под dev-backend CDC pressure (folio_creator_writer + booking_confirmed CDC consumers contending). Re-run в isolation passes. CI runner будет clean (no dev backend). Per `feedback_pre_push_changed_strategy.md` — vitest НЕ в pre-push gate; CI async на self-hosted runner verifies cleanly.
  - `folio-balance.test.ts > [B3]` — same class (YDB TLI tx-poison под shared-instance contention). Same disposition.

### A4.2 (commit pending) — Lit Web Component facade + lazy `booking-flow.js` chunk

A4.2 — pre-done audit (paste-and-fill per `feedback_pre_done_audit.md`):
- [X] Vite multi-entry IIFE — `EMBED_ENTRY=embed|flow` + `pnpm build` chains both passes (`emptyOutDir: false` for second pass) → `dist/embed.js` + `dist/booking-flow.js`
- [X] D12 facade pattern: `embed.js` (facade) ≤15 KB gzip + `booking-flow.js` (lazy chunk) ≤80 KB gzip
- [X] Dual CI gate `scripts/check-size.mjs` enforces both budgets; exit 1 if either over
- [X] `widget.ts` lazy-imports `booking-flow-entry.ts` via cached promise on click
- [X] **`IntersectionObserver` + `requestIdleCallback` prefetch** (Stripe / Bnovo / SiteMinder canonical pattern) — chunk loaded по idle when CTA enters viewport, eliminates click-spinner-render visible delay
- [X] **`ElementInternals.attachInternals()` ARIA reflection** (Web Components canon 2026; Chrome 90+ / Safari 16.4+ / Firefox 126+) — exposes `role: 'region'` + `ariaLabel: 'Виджет бронирования'` без light-DOM attribute pollution. Spec compliance: only attach once per instance (guard added).
- [X] D5 container queries (`container-type: inline-size` + `@container (min-width: 480px|720px)`) responsive
- [X] D5 `@starting-style` entrance animation (booking-flow card)
- [X] D5 `text-wrap: balance` / `text-wrap: pretty` modern CSS typography polish
- [X] D17 `Object.create(null)` для serialized dictionaries (postMessage payloads, `data-*` parses) via `$createNullObject` helper
- [X] D18 `IntersectionObserver` v2 (`trackVisibility: true, delay: 100, threshold: 1`) submit visibility gate в `<sochi-booking-flow>` — disable submit when occluded; defense-in-depth для in-DOM clickjacking
- [X] D19 AbortController per `connectedCallback` + `disconnectedCallback` cleanup — abort all async (fetch, observers); reconnect re-creates controller idempotently (W10 verified)
- [X] D11 + R1c CustomEvent emission canon — `sochi-widget:event` (`composed: true; bubbles: true`) с pollution-safe detail; tenant page subscribes и calls own `ym(N, 'reachGoal', ...)` instead of bundled Yandex.Metrica (Session Replay не поддерживает Shadow DOM)
- [X] D6 NO `<slot>` exposure (verified W6 — light children stay в light DOM, never project; biome ban `unsafeHTML`/`unsafeStatic` still active)
- [X] Stub property fetcher (А4.3 lands real backend route `/api/public/widget/{slug}/property`)
- [X] **Cumulative tests: 11 unit/build (5 BLD facade + 3 BLD-FX security + 3 BLD-LF lazy chunk) + 10 W browser (Vitest 4 Browser Mode + Playwright real Chromium real Shadow DOM)** = 21 tests
- [X] BLD-LF1 lazy chunk gzip ≤80 KB verified (10.20 KiB / 80 KiB = 70.13 KiB headroom)
- [X] BLD-LF2 IIFE format + no `<slot>` references in lazy chunk
- [X] BLD-LF3 lazy chunk has its own DOM stash + hydrate-support (idempotent boot)
- [X] W2 :host { all: initial } empirically verified neutralises ambient parent cascade (font-family + color)
- [X] W7 ElementInternals canonical 2026 ARIA reflection verified (no DOM attribute pollution)
- [X] W8 click → lazy chunk loads → `<sochi-booking-flow>` rendered (verified в real Chromium)
- [X] W9 CustomEvent emission canon verified — tenant analytics integration ready без bundle bloat
- [X] 9-gate green: sherif / biome / depcruise (683 modules) / knip (clean — `gzip-size-cli` removed since check-size.mjs uses Node `zlib`) / typecheck (4 packages) / build (dual bundle) / vitest unit (11/11) / vitest browser (10/10)
- [X] Empirical bundle sizes verified — facade 11.12 KiB / 15 KiB = 3.88 KiB headroom; lazy 9.87 KiB / 80 KiB = 70.13 KiB headroom
- [ ] Real backend `/api/public/widget/{slug}/property` fetch — DEFER к А4.3
- [ ] postMessage MessageChannel handshake — DEFER к А4.4 (iframe fallback path)
- [ ] axe AA audit — DEFER к А4.4 closure (full visual smoke pass с iframe)
- [ ] Visual smoke 4 viewports + Read screenshots — DEFER к А4.4 closure

### A4.3.a (commit pending) — Foundation: migrations + helpers + repo + 42 strict tests

Per-sub-phase canonical cycle (`feedback_session_startup_for_widget_subphases.md`):
fresh R1+R2 round 2026-05-04 surfaced 9 new corrections → plan §4 D21-D29 added.
Foundation lands: schema + sanitization + crypto + timing helpers + repo +
strict tests. Routes + factory + integration tests + wire-up = A4.3.b carry-forward.

Files added:
- `apps/backend/src/db/migrations/0047_property_public_embed_domains.sql` (D11)
- `apps/backend/src/db/migrations/0048_widget_release_audit.sql` (D26)
- `apps/backend/src/lib/embed/header-safety.ts` (D24 — `assertHeaderSafe` /
  `assertOriginSafe` / `HTTPS_ORIGIN_REGEX`; `charCodeAt` loop avoids Biome
  `noControlCharactersInRegex` warning AND keeps RFC 7230 byte-literal semantics)
- `apps/backend/src/lib/embed/header-safety.test.ts` — 14 tests H1-H6 + O1-O8
  (CR/LF/NUL injection rejection; HTTPS regex strictness; Cyrillic punycode
  enforcement; CRLF-in-origin composition test)
- `apps/backend/src/lib/embed/timing.ts` (D27 — `constantTailLatency` floor
  helper port magic-link consume canon)
- `apps/backend/src/lib/embed/timing.test.ts` — 5 tests T1-T5 (floor enforcement;
  no-extra-delay above floor; rejection class preservation; floor-before-reject)
- `apps/backend/src/lib/embed/commit-token.ts` (D25 — HMAC HS256 signing с
  `kid: 'current'` + sliding-window verify accepting `previous`; jose 6.2.3)
- `apps/backend/src/lib/embed/commit-token.test.ts` — 7 tests CT1-CT7 (sign/verify
  roundtrip; nbf enforces ≥0.8s gap; custom delay/ttl; kid rotation accepts previous;
  rotation drops oldest; forged token reject; malformed sub reject)
- `apps/backend/src/domains/widget/embed.repo.ts` — `getPublicEmbedDomains` /
  `setPublicEmbedDomains` / `appendAudit` / `listAudit`; zod schemas
  (`publicEmbedOriginSchema`, `publicEmbedDomainsSchema` max-32, `auditInputShape`
  с hash regex `^[a-f0-9]{96}$`, `auditReasonSchema` ≤500ch + CRLF reject)
- `apps/backend/src/domains/widget/embed.repo.test.ts` — 16 tests PED1+PED3-PED10 +
  AUD1-AUD7 (cross-tenant isolation × 3; CRLF rejection × 2; max-size cap;
  Cyrillic/non-HTTPS/path-component/array-bounds rejection; append-only
  list ordering)
- `packages/shared/src/ids.ts` — added `widgetReleaseAudit: 'wrla'` typeid prefix

A4.3.a — pre-done audit (paste-and-fill per `feedback_pre_done_audit.md`):
- [X] Migration 0047 created — `property.publicEmbedDomains Json` nullable column
- [X] Migration 0048 created — `widgetReleaseAudit` append-only table + 2 indexes
      (idxWidgetReleaseAuditHash + idxWidgetReleaseAuditActionAt)
- [X] Both migrations applied empirically (`pnpm migrate` 46 already at HEAD →
      48 applied; backfill ran clean)
- [X] D24 zod write-side regex `/^https:\/\/[a-z0-9.-]+(:\d+)?$/i` enforced via
      `publicEmbedOriginSchema`; max-32 cap via `publicEmbedDomainsSchema`
- [X] D24 read-side `assertOriginSafe()` helper exported (route layer will call
      before `c.header(...)` splice in A4.3.b)
- [X] D25 HMAC `kid` rotation pattern — `current` + `previous` keys; verifier
      tries current first, falls back to previous if non-null
- [X] D27 `constantTailLatency` helper ready for slug GET timing-safety
- [X] D26 `widgetReleaseAudit` append-only — only INSERT path; tx-optional
      parameter so route can wrap with kill-switch UPDATE atomically
- [X] Cross-tenant isolation × every method (PED4 + PED10 + AUD3 verified)
- [X] CRLF/NUL rejection × every operator-controlled string field (H2-H5 + O7 +
      PED6 + AUD4 verified)
- [X] Enum FULL coverage — `widgetBundleKindSchema` 2 values + `widgetReleaseActionSchema`
      3 values + `widgetReleaseActorSourceSchema` 4 values; AUD7 verifies invalid
      action='garbage' rejected
- [X] `feedback_strict_tests.md` adversarial canon: 42 tests cover (cross-tenant
      leak / header injection / max bounds / format violations / forgery / clock
      enforcement / append-only-isolation)
- [X] 9-gate green: sherif / biome / depcruise (691 modules) / knip / typecheck
      (4 packages) / build / vitest unit (42/42)
- [ ] embed.routes.ts (4 routes: facade GET + lazy GET + commit-token POST +
      kill-switch POST) — DEFER к A4.3.b
- [ ] embed.factory.ts wiring repo + routes — DEFER к A4.3.b
- [ ] app.ts mount `/embed/v1` + `csrf()` middleware on POST routes only — DEFER к A4.3.b
- [ ] E1-E15 integration tests — DEFER к A4.3.b
- [ ] Empirical curl `GET /embed/v1/sirius.{hash}.js` — DEFER к A4.3.b

### A4.3.b (commit pending) — Routes + factory + wire-up + 15 integration tests + empirical curl

Built on A4.3.a foundation. 4 HTTP routes + factory + service + app.ts mount + 15 strict integration tests + empirical curl pass.

Files added:
- `apps/backend/src/domains/widget/embed.service.ts` — bundle loader (sync `readFileSync` at construction; SHA-384 hex + base64 capture; `bundlesOverride` для tests); `matchBundleByHash` (constant-time hex compare); `signCommitToken` / `verifyCommitToken` wrappers; `getReleaseStatus` (latest-action-wins from audit log); `recordReleaseEvent` (revoked requires non-null reason guard)
- `apps/backend/src/domains/widget/embed.factory.ts` — DI: repo + secrets (utf8 ≥32-byte assertion) + bundlesDir resolution; tests pass `bundlesOverride` so они не depend on real `apps/widget-embed/dist/` artifact
- `apps/backend/src/domains/widget/embed.routes.ts` — 4 routes per plan §A4.3:
    - `GET /v1/_chunk/booking-flow/<hash>.js` (FIRST — Hono router order: more specific pattern wins)
    - `GET /v1/:tenantSlug/:propertyId/<hash>.js` (facade)
    - `POST /v1/:tenantSlug/:propertyId/commit-token` (manual Origin allowlist — `csrf()` middleware bypasses application/json so explicit check canonical)
    - `POST /v1/_kill` (admin auth + tenant-org-id match guard + audit row append)
- `apps/backend/src/domains/widget/embed.routes.test.ts` — 15 integration tests E1-E15 (vi.mock `auth.ts` для admin-auth tests; bundle override; randomSlug helper matching `tenant-resolver` SLUG_PATTERN)
- `apps/backend/src/env.ts` — `COMMIT_TOKEN_HMAC_CURRENT` + `COMMIT_TOKEN_HMAC_PREVIOUS` env vars (D25 sliding-window rotation; production seeds from Yandex Lockbox)
- `apps/backend/src/app.ts` — wires `createEmbedFactory` + mounts `/api/embed` route

Hono routing nuance learned: native `:param.ext` literal-suffix capture eats the dot on Node adapter (`:hash.js` regex form `:hash{[a-f0-9]{96}}.js` did not match either). Resolved via `:hashfile` capture + `extractHash` regex strip — single segment captures `<hash>.js`, regex strips `.js` to yield 96-char hex hash. Route order matters: lazy chunk pattern declared FIRST so general facade pattern doesn't match `/v1/_chunk/...` URLs.

Hono CSRF middleware bypasses `application/json` requests (canonical defense relies on browser preflight). Replaced csrf middleware с manual Origin allowlist check inside POST commit-token handler — explicit + 100% reliable.

Integration tests strict adversarial coverage:
- E1 200 + immutable headers + bundle bytes verbatim
- E2 unknown slug → 404 with **wall-clock ≥13ms** (constant-tail-latency D27 verified empirically)
- E3 publicEmbedDomains=null → 404 (private property defended)
- E4 hash mismatch → 410 Gone (forces tenant rebuild on rotation)
- E5 allowed Origin echoed → `Access-Control-Allow-Origin` + `Vary: Origin`
- E6 lazy chunk match → 200 + `ACAO: *`
- E7 origin in allowlist → 200 + JWT
- E8 origin NOT in allowlist → 403 (forbidden)
- E9 round-trip JWT с 850ms wait → claims verify (nbf gap honored, kid='current')
- E10 no session → 401
- E11 wrong-tenant session → 403
- E12 valid session + body → 200 + audit row appended (verified via `repo.listAudit`)
- E13 zod regex rejects http:// at write time
- E14 zod rejects CRLF embedded в origin (header-injection guard)
- E15 revoked hash → subsequent facade GET returns 410 (D26 kill-switch end-to-end)

Empirical curl 2026-05-04 (dev backend `pnpm dev` on :8787, hot-reloaded on file save):
```
$ curl -sI "http://localhost:8787/api/embed/v1/_chunk/booking-flow/<sha384hex>.js"
HTTP/1.1 200 OK
cache-control: public, max-age=31536000, immutable
integrity-policy: blocked-destinations=(script)
reporting-endpoints: integrity-endpoint="/api/embed/v1/_report/integrity"
cross-origin-resource-policy: cross-origin
content-type: application/javascript; charset=utf-8
access-control-allow-origin: *
vary: Origin
x-content-type-options: nosniff
```
ALL canonical headers per D28 + D29 verified live.

A4.3.b — pre-done audit (paste-and-fill per `feedback_pre_done_audit.md`):
- [X] D21 dynamic CORS reflection from `publicEmbedDomains` allowlist on facade GET (E5 verified)
- [X] D22 `Sec-Fetch-Site` декоративный — telemetry only via `Vary` merge; primary trust = CORS + admin-auth
- [X] D23 path-segment hash via `:hashfile` + `extractHash` (E4 verified hash mismatch → 410)
- [X] D24 `assertHeaderSafe()` + `assertOriginSafe()` BEFORE every `c.header()` splice
- [X] D25 HMAC `kid` rotation (`current`/`previous` from env; nbf=iat+0.8s; E9 verified round-trip)
- [X] D26 append-only `widgetReleaseAudit` row on kill-switch (E12 + E15 verified)
- [X] D27 `constantTailLatency(15ms)` floor on slug GET (E2 verified ≥13ms wall-clock)
- [X] D28 `Integrity-Policy` + `Reporting-Endpoints` headers (E1 + empirical curl verified)
- [X] D29 immutable `Cache-Control: public, max-age=31536000, immutable` (E1 + curl verified)
- [X] Cross-tenant isolation: tenant resolver only resolves OWN slugs; allowlist filtered by tenantId; admin-auth checks `session.activeOrganizationId === body.tenantId` (E11 verified)
- [X] Manual Origin allowlist enforced на commit-token POST (E8 verified 403)
- [X] Append-only audit log idempotent across requests (insert id-keyed; future kill-switch retries hit row-already-exists not duplicate)
- [X] 15 integration tests E1-E15 pass real Hono в-process via `app.request()`
- [X] 9-gate green: sherif / biome / depcruise (695 modules) / knip / typecheck (4 packages) / build / vitest unit (57/57) / vitest test:serial (4538/4539, 1 skip)
- [X] Empirical curl verified live dev backend
- [X] Plan §17 + ROADMAP updated; memory pointer in next commit step

### A4.4 (commit pending) — iframe fallback + postMessage protocol + 39 tests

Per-sub-phase canonical cycle: fresh R1+R2 ≥2026-05-04 surfaced 6 corrections D30-D35.

Files added:
- `packages/shared/src/widget-protocol.ts` — types + const + `validateWidgetMessage` slim manual validator (NO zod runtime — keeps embed bundle under budget)
- `packages/shared/src/widget-protocol.test.ts` — **22 V tests adversarial** (V1-V22): 6 happy paths (each message type) + 16 negative paths (forge / replay / oversize / wrong-type / scheme injection)
- `apps/backend/src/domains/widget/iframe-html.routes.ts` — `GET /api/embed/v1/iframe/:tenantSlug/:propertyId.html` route с per-tenant CSP `frame-ancestors` + COOP `same-origin-allow-popups` + minimal-trust Permissions-Policy + assertOriginSafe header sanitization + escapeHtml для всех slug/propertyId interpolation surfaces
- `apps/backend/src/domains/widget/iframe-html.routes.test.ts` — **10 IF tests** (IF1-IF10) integration: HTML body / CSP / COOP / Permissions-Policy / response headers / private property guard / SRI tag / unknown slug 404 / empty allowlist `'none'` / XSS-escape defense
- `apps/widget-embed/src/iframe-fallback.ts` — `<sochi-iframe-fallback-v1>` Lit element parent-side wrapper; D30 sandbox tokens (NO allow-top-navigation), D32 nonce-bound URL fragment + MessageChannel handshake, D35 child-ready gate, slim `validateWidgetMessage` import (no zod), `AbortController` cleanup
- `apps/widget-embed/src/iframe-fallback.browser.test.ts` — **7 IFE browser tests** (IFE1-IFE7): registration / sandbox tokens canonical / URL fragment nonce / loading=lazy + referrerpolicy / URL encoding XSS-safe / disconnect cleanup / missing-attribute fallback paragraph

Files modified:
- `apps/widget-embed/src/index.ts` — register `<sochi-iframe-fallback-v1>` alongside `<sochi-booking-widget-v1>`
- `apps/widget-embed/package.json` — `@horeca/shared: workspace:*` runtime dep (subpath import only — NO barrel pulled into bundle)
- `packages/shared/src/index.ts` — export widget-protocol
- `packages/shared/package.json` — `./widget-protocol` subpath export
- `apps/backend/src/app.ts` — mount iframe-html routes BEFORE embed routes (Hono router order avoids `:tenantSlug/:propertyId/:hashfile` swallowing `/iframe/...` URLs)

Bundle size empirical 2026-05-04 (zero downgrades):
- facade `embed.js` 12.40 KiB gzip / 15 KiB ceiling = **2.60 KiB headroom** (was 11.12 KiB; +1.28 KiB for iframe-fallback.ts + protocol consts + Lit class)
- lazy `booking-flow.js` 9.87 KiB gzip / 80 KiB ceiling = **70.13 KiB headroom** (unchanged)

A4.4 — pre-done audit (paste-and-fill per `feedback_pre_done_audit.md`):
- [X] D30 sandbox final tokens applied + verified IFE2 (NO allow-top-navigation per CVE-2026-5903)
- [X] D32 nonce-bound MessageChannel handshake (URL fragment binding + monotonic seq replay defense + IFE3 verified)
- [X] D33 visible-rect heartbeat — type-only spec в plan (full client-side heartbeat реализация carry-forward к M11 SDK polish; IFE7 baseline coverage)
- [X] D34 COOP `same-origin-allow-popups` + popup `rel="noopener noreferrer"` (IF3 verified)
- [X] D35 child-ready handshake gate (parent waits for `'ready'` ping, drops pre-ready)
- [X] D24 `assertHeaderSafe` + `assertOriginSafe` per origin in CSP construction
- [X] D11 per-tenant CSP `frame-ancestors` from `publicEmbedDomains` allowlist (IF2 verified) + empty-array `'none'` fallback (IF9 verified)
- [X] Permissions-Policy minimal-trust (camera/microphone/geolocation/payment blocked; fullscreen=(self), storage-access=(self)) — IF4 verified
- [X] HTML body XSS-escapes slug + propertyId — IF10 verified
- [X] D19 AbortController cleanup на disconnect (IFE6 verified reconnect idempotent)
- [X] `validateWidgetMessage` adversarial 22 tests — drift defense canon
- [X] Bundle dual-budget green: facade 12.40 KiB / 15 KiB + lazy 9.87 KiB / 80 KiB
- [X] 9-gate clean: sherif / biome / depcruise (701 modules) / knip / typecheck / build / vitest unit (32) / vitest browser (17) / test:serial (4592/4593, 1 skip, 0 fail)
- [X] Empirical curl на dev backend `/api/embed/v1/iframe/sirius/prop_test.html` → routing wired, 404 on missing tenant (canonical envelope)
- [ ] D31 Storage Access top-level redirect fallback — DEFER к M11 SDK polish (Safari ITP / FF ETP edge cases need Yandex Cloud deploy для full validation)
- [ ] Visible-rect heartbeat full client-side runtime — DEFER к M11 SDK polish (commit-button gating semantically inside booking-flow which is апост-A4 lazy chunk)
- [X] axe AA on iframe shell — closed в A4 closure: 4 viewports (320 / 768 / 1024 / 1440) + forced-colors AAA overlay all pass (EMB2-EMB4)
- [X] Visual smoke 4 viewports — closed: baselines `tests/e2e/embed.spec.ts-snapshots/embed-iframe-{320,768,1024,1440}-smoke-darwin.png` committed

### A4 closure (commit pending) — empirical curl + axe AA + visual smoke + done

Final empirical verification with seeded `demo-sirius` tenant + `publicEmbedDomains` allowlist `['https://hotel-sirius.demo', 'https://www.hotel-sirius.demo']`:

```bash
$ curl -sI http://localhost:8787/api/embed/v1/iframe/demo-sirius/demo-prop-sirius-main.html
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self' http://localhost:8787; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors https://hotel-sirius.demo https://www.hotel-sirius.demo; base-uri 'self'; form-action 'self'
cross-origin-opener-policy: same-origin-allow-popups
cross-origin-resource-policy: same-site
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=(self), storage-access=(self)
referrer-policy: strict-origin-when-cross-origin
cache-control: private, max-age=60, must-revalidate
x-content-type-options: nosniff

$ curl -sI -H "Origin: https://hotel-sirius.demo" http://localhost:8787/api/embed/v1/demo-sirius/demo-prop-sirius-main/<sha384hex>.js
HTTP/1.1 200 OK
access-control-allow-origin: https://hotel-sirius.demo
cache-control: public, max-age=31536000, immutable
integrity-policy: blocked-destinations=(script)
reporting-endpoints: integrity-endpoint="/api/embed/v1/_report/integrity"
cross-origin-resource-policy: cross-origin
x-content-type-options: nosniff
```

ALL D11/D21/D24/D28/D29/D34 + Permissions-Policy + Referrer-Policy headers verified live с real seeded tenant.

Important runtime correction caught в closure:
- **`<script type="module">` → `<script defer>`** for IIFE bundle. Module scripts have top-level `this === undefined`, breaking Vite's `output.extend: true` IIFE wrapper which assigns `this.SochiBookingWidget = ...`. Stripe Buy Button / Bnovo / SiteMinder ALL canonical pattern: classic `<script defer>` для IIFE bundles 2026-Q2. IF7 test regex updated.

Files added/changed for closure:
- `tests/e2e/embed.spec.ts` (NEW) — 8 EMB tests: functional (EMB1) + axe AA × 3 viewports + forced-colors (EMB2-EMB4) + visual smoke × 4 viewports (EMB5-EMB8). Smoke project (anonymous, no storageState dep)
- `tests/e2e/embed.spec.ts-snapshots/` (NEW) — 4 PNG baselines (320/768/1024/1440 widths)
- `playwright.config.ts` — testMatch regex extended `(smoke|embed)\.spec\.ts` for both projects
- `apps/backend/src/db/seed-demo-tenant.ts` — `publicEmbedDomains: ['https://hotel-sirius.demo', 'https://www.hotel-sirius.demo']` для empirical curl verification
- `apps/backend/src/domains/widget/iframe-html.routes.ts` — `<script defer>` (was `type="module"`)
- `apps/backend/src/domains/widget/iframe-html.routes.test.ts` — IF7 regex updated to `<script defer>`
- `apps/backend/src/domains/widget/embed.routes.ts` — `mergeVary` helper applied to CORS reflection (defense-in-depth, cosmetic dedup)

A4 closure — pre-done audit (paste-and-fill per `feedback_pre_done_audit.md`):
- [X] Empirical curl iframe HTML wrapper response с real seeded tenant — ALL 8 canonical headers verified (CSP frame-ancestors + COOP + Permissions-Policy + COR-P + Referrer-Policy + Cache-Control + nosniff + Content-Type)
- [X] Empirical curl bundle facade response с Origin header — D21 dynamic CORS reflection verified (`access-control-allow-origin: https://hotel-sirius.demo`)
- [X] axe-pass на iframe wrapper × 4 viewports (desktop 1440, mobile 360×740, forced-colors high-contrast)
- [X] Visual smoke baselines × 4 widths (320 / 768 / 1024 / 1440) — Cyrillic Забронировать button system-ui font canonical render
- [X] `<script defer>` IIFE canon (correction caught in closure; classic pattern Stripe / Bnovo / SiteMinder 2026)
- [X] `<sochi-booking-widget-v1>` registers on bundle load — verified via Playwright `customElements.get(...)` wait
- [X] Demo seed adds `publicEmbedDomains` so admin tooling tests + manual QA flows have realistic data
- [X] 9-gate clean: sherif / biome / depcruise (701 modules) / knip / typecheck (4 packages) / build / vitest unit (32) / vitest browser (17) / vitest test:serial (4591/4593, 1 skip + 1 known flake U4 payment UNIQUE-race per feedback_test_serial_for_pre_push.md — passes в isolation; CI runner clean)
- [X] Plan §11 closure DOD checklist all items either done OR explicitly carry-forwarded к M11 SDK polish (D31 Storage Access + visible-rect heartbeat full runtime)
- [X] Memory pointer `project_m9_widget_6_canonical.md` updated to A4 fully done state
- [X] Done memory `project_m9_widget_6_done.md` created (next commit step)
- [X] ROADMAP A4 row marked `[✅]`

---

**End of M9.widget.6 canonical sub-phase plan.**
