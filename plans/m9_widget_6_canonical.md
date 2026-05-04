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

## §4. 12 Decisions (final, post R1+R2)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | Web Component framework | **Lit 3.3.2 + @lit-labs/ssr 4.0.0** | npm verified 2025-12-23 latest stable. Lit baseline ~5-6 kB gzip leaves ~24 kB headroom. DSD-SSR universally supported (94.6% caniuse). |
| **D2** | Bundler | **Vite 8.0.10 native lib mode (NO vite-plugin-singlefile)** | Native `build.lib.formats: ['iife']` + `rollupOptions.output.inlineDynamicImports: true` produces single ES module. Plugin solves different problem (inline-into-HTML), не нужен. |
| **D3** | Minifier | **Terser 5.46.2** (NOT default Oxc) | Vite 8 default Oxc faster но 0.5-2% worse gzip. На 30 kB cliff каждый byte counts. Terser canonical. |
| **D4** | Custom element registration | **`if (!customElements.get(name)) define(...)` guard + versioned tag `sochi-booking-widget-v1`** | DOMException collision (lit-element issue #771): tenant accidentally pastes embed twice OR conflicts с GTM/Yandex.Metrica. Defensive idempotent IIFE. |
| **D5** | CSS scoping | **`:host { all: initial; display: block; }` + `:root, :host` theme selector + preflight opt-out** | Tailwind v4 preflight `*` pierces shadow boundary (GH #18628). `:host { all: initial }` defends against parent cascade (font-family, color, line-height). |
| **D6** | Slot exposure | **NO `<slot>` exposure в M9.widget.6 scope. Ban `unsafeHTML`/`unsafeStatic` via Biome** | XSS mitigation (R2 #3). Light children через slot project через shadow boundary; `<img onerror>` / `<iframe srcdoc>` от parent injection executes в light DOM owner document context. |
| **D7** | Cross-origin iframe | **Distinct registrable domain `widget-embed.sochi.app` OR sandbox без `allow-same-origin`** | Sandbox `allow-scripts allow-same-origin` provably insecure (MDN — frame can strip sandbox via parent.frameElement). Distinct eTLD+1 prevents this attack. |
| **D8** | Cookie scope iframe | **`__Host-guest_session` + `Partitioned; Secure; SameSite=None; HttpOnly`** | Chrome 115+ blocks 3rd-party cookies без `Partitioned`. CHIPS canonical 2026 (privacysandbox.google.com 2025-10). |
| **D9** | postMessage protocol | **MessageChannel transferred-port handshake + `event.source === iframeRef.contentWindow` check** | Origin spoofing (attacker iframe `src=widget.sochi.app/anything`) bypasses startsWith/regex origin check. Strict `===` + source-binding canonical. |
| **D10** | Supply-chain | **SHA-384 SRI + `crossorigin="anonymous"` + Integrity-Policy HTTP header** | MDN 2026-03-22 — Integrity-Policy блокирует scripts без SRI. Lessons из polyfill.io 2024 supply-chain compromise. |
| **D11** | Per-tenant CSP | **`property.publicEmbedDomains` JSON column → backend injects `frame-ancestors` per-tenant + Sec-Fetch-Site parent verify + 429 на slug-probe** | R2 #5 — multi-tenant enumeration. M9.widget.1 already added `property.isPublic`; extend с domain allowlist. |
| **D12** | Bundle size gate | **CI: `gzip-size dist/embed.js --raw` ≤ 30720 bytes** | Hard gate per plan §10 target. `vite-bundle-visualizer` for chunk inspection. Subpath imports mandatory (Vite #21966 — barrel imports blow up). |

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

### A4.1 Embed package scaffold + bundle (~1 day, ~5 tests)
1. `apps/widget-embed/` workspace setup (`pnpm-workspace.yaml` add)
2. `package.json` + `tsconfig.json` + `vite.config.ts`
3. Empty Lit component shell `widget.ts`
4. CI gate `gzip-size` ≤ 30720 bytes
5. BLD1-BLD5 build tests

### A4.2 Embed bundle Lit Web Component implementation (~2 days, ~10 tests)
6. `<sochi-booking-widget>` actual implementation — fetches `/api/public/widget/{slug}/property/{id}` + renders DSD SSR markup
7. `:host { all: initial }` CSS defense + Tailwind v4 workaround
8. Defensive `customElements.define` guard
9. W1-W10 component tests via Vitest Browser Mode

### A4.3 Backend embed.routes + migration 0047 (~1 day, ~10 tests + 1 migration)
10. Migration 0047 — `property.publicEmbedDomains` Json column
11. `domains/widget/embed.routes.ts` — bundle delivery + per-tenant CSP + Integrity-Policy
12. Wire `app.ts` под `/embed/v1`
13. E1-E10 integration tests

### A4.4 iframe fallback + postMessage handshake (~1 day, ~5 tests)
14. iframe fallback wrapper component
15. postMessage MessageChannel handshake helper
16. ResizeObserver debounced height auto-resize
17. IF1-IF5 component tests
18. Empirical curl: GET `/embed/v1/sirius.js` → bundle + headers verified

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

### A4.1 (commit pending)
TBD — embed package scaffold + bundle CI gate findings.

### A4.2 (commit pending)
TBD — Lit Web Component implementation findings.

### A4.3 (commit pending)
TBD — backend embed.routes + migration 0047 findings.

### A4.4 (commit pending)
TBD — iframe fallback + postMessage handshake findings.

---

**End of M9.widget.6 canonical sub-phase plan.**
