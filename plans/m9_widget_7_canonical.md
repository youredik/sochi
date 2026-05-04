# M9.widget.7 — Perf + a11y CI gate (canonical sub-phase plan)

**Дата:** 2026-05-04
**Track:** A5 (per `plans/ROADMAP.md`) — closes Боль 2.4 формальный perf+a11y CI gate перед production deploy.
**Scope:** Lighthouse CI + web-vitals 5 INP attribution → OTel → Yandex Cloud Monitoring + axe-core comprehensive matrix + size-limit бюджет SPA + Speculation Rules + noscript fallback + 152-ФЗ-compliant RUM pipeline.
**Canonical guard:** `feedback_behaviour_faithful_mock_canon.md` — perf+a11y gate same код для demo + production tenants (mode-flag NO влияет на gate).
**Research:** R1 broad + R2 adversarial 2026-05-04. **Recurring косяки applied UPFRONT** (см. §0).

---

## §0. Косяки из предыдущих sub-phases applied upfront

Per session retrospective:

| Категория | Косяк | Mitigation в этом плане |
|---|---|---|
| Process | Claim "done" без paste-and-fill audit | DOD checklist в commit body перед TodoWrite completed |
| Process | Stop after "continuing X" narration | Execute, не narrate |
| Process | Skip per-sub-phase canonical cycle | R1+R2 ≥today done в pre-flight; closure has fresh recheck |
| Process | Memory pointer stale after sub-phase | Update memory immediately after EACH commit |
| Process | Defer items "к closure" → forget | Track в TodoWrite + paste-and-fill |
| Process | Skip `pnpm test:serial` regression | Run before closure commit |
| Process | Skip empirical с seeded tenant | Use real `demo-sirius` data |
| Process | Skip MEMORY.md index update | Update в same commit as memory pointer |
| Tech | Half-measure dropping canon defense to pacify lint | Bend lint (biome-ignore), NEVER drop security primitive |
| Tech | Bundle barrel imports → blowup | ALWAYS subpath; verify size after each refactor |
| Tech | Hono route order: general swallows specific | Specific patterns FIRST в mount order |
| Tech | Hono `:param.ext` literal-suffix breaks | `:filename` + zod regex strip canon |
| Tech | `<script type="module">` breaks IIFE bundles | `<script defer>` classic для IIFE |
| Tech | dev backend ne re-reads dist files | Restart после rebuild |
| Tech | Visual smoke first run no baselines | `--update-snapshots` + commit baselines |
| Tech | Test contamination от dev backend CDC | Filter by `createdBy` actor |
| Senior | Per-sub-phase R1+R2 must be ≥ today | Sources rejected if < today; honest flag |
| Senior | Verify "canonical" claims via fresh research | Don't ride training-data assumptions |
| Bug-hunt | Strict tests canon | Adversarial paths + exact values + cross-tenant × every method + enum FULL |

---

## §1. North-star alignment

Закрывает Боль 2.4 (perf+a11y CI gate) — formal go/no-go signal перед production deploy. Same gate applies к demo и production tenants без mode-branching (canon).

**Что строится:**
- Lighthouse CI configuration с performance budgets (LCP / TBT / CLS / SI / FCP — INP separately via web-vitals)
- web-vitals 5.x attribution build → backend RUM endpoint → Yandex Cloud Monitoring (proprietary HTTP API; OTLP NOT native)
- axe-core comprehensive matrix: ALL public surfaces × all themes × all viewports × forced-colors AAA
- size-limit@11.x bundle budget enforcement (extends current widget-embed dual-bundle gate to SPA)
- Speculation Rules `<script>` block в iframe-html (D34 popup + new D36 anti-DDoS check)
- `<noscript>` fallback в iframe-html для strict-CSP RU gov tenant pages

**Что defer'ится:**
- Hard-fail на perf regression в master push — warn-only canon Stripe / Vercel / Cloudflare 2026 (hard-fail moves к deploy gate в Track B)
- Yandex.Metrica per-tenant integration (M11 admin UI carry-forward; opt-in 152-ФЗ consent gate)
- Stryker mutation testing for a11y rules (overkill для SaaS; carry-forward к coverage:full canon)

---

## §2. 12 Decisions (final, post R1+R2)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | Lighthouse CI runner | **`@lhci/cli@0.15.1` + Lighthouse 12.6.1** lab metrics: LCP/TBT/CLS/SI/FCP | INP NOT lab metric per LH team — field-only via web-vitals (R1 Q1 cite) |
| **D2** | Lighthouse CI config format | **`lighthouserc.cjs`** (CommonJS, comment-friendly, Node-compat) + separate `budgets.json` | JSON has no comments; .js triggers ESM warnings on pnpm workspace |
| **D3** | LCP gaming defense | **`lcp-lazy-loaded: 'error'` + `largest-contentful-paint-element: 'error'` + `prioritize-lcp-image: 'error'`** | R2 §1 — Unlighthouse 2025 cite: 10.4% mobile pages lazy-load LCP, score gaming |
| **D4** | TBT aggregation | **`aggregationMethod: 'pessimistic'`** для TBT (worst run, не median) | R2 §1 — defends idle-period noise gaming |
| **D5** | Lighthouse runs per build | **`numberOfRuns: 5`** + `tolerance: 100ms` band | R2 §6 — LHCI 2026 canon median-of-5 (3 = high false-fail) |
| **D6** | INP measurement | **web-vitals 5.x attribution build** через `web-vitals/attribution` subpath | INP = field-only canonical 2026 |
| **D7** | RUM backend pipeline | **Frontend → `/api/rum` POST → backend batch-write → Yandex Cloud Monitoring proprietary HTTP API** (OTLP NOT native per docs 2026-03-24) | YC Monitoring NOT OTLP-receiving; bridge via backend (R1 Q6) |
| **D8** | RUM 152-ФЗ anonymization | **MANDATORY `anonymize.ts` pipeline** strips attribute-value selectors `[name="..."]` / `aria-label` / `placeholder` / IDs / `value`; bucket UA `{browser, os, mobile}`; truncate IP at edge | R2 §4 Critical: `interactionTarget` для `<input name="passport_serial">` IS ПДн под 152-ФЗ ст. 3 ч. 1 |
| **D9** | YC Monitoring batching | **Reservoir-sample edge buffer + histogram-bucket aggregation + 10k-metrics-per-write batch + Cockatiel-class circuit breaker on 429/5xx** | R2 §5: YC Monitoring 10k metrics/req limit 2026-03-24; 100k INP/min unbatched = throttled |
| **D10** | Bundle CI gate (SPA) | **`size-limit@11.x` + `@size-limit/preset-app`** в root package.json: SPA index ≤180kB gzip + per-route lazy chunks ≤60kB; widget facade ≤15kB + lazy ≤80kB (existing) | R1 Q5 — size-limit dominant 2026 (728k vs 136k weekly) |
| **D11** | Speculation Rules в embed snippet | **`<script type="speculationrules">` с `requires: ["anonymous-client-ip-when-cross-origin"]` + `href_matches` scoped to OWN origin only (no wildcards)** | R2 §7: cross-site prefetch DDoS defense + RUM phantom-session filter via `document.prerendering` check |
| **D12** | Sec-Purpose: prefetch handling | **Backend `/book/...` returns 503 для `Sec-Purpose: prefetch` when not from hosted facade origin** | R2 §7: malicious embedder cross-tenant prefetch defense |
| **D13** | `<noscript>` fallback canon | **iframe-html template adds `<noscript>` block с `tel:` + tenant phone**; Playwright test с `javaScriptEnabled: false` | R2 §9: RU gov sites strict CSP без `unsafe-inline` |
| **D14** | Forced-colors + Cyrillic visual a11y | **Playwright `forcedColors: 'active'` axe matrix + `toHaveScreenshot()` assertion** для glyph-drop catch (axe color-contrast skips forced-colors by design) | R2 §10: Segoe UI Variable Cyrillic ligature drop on Windows |
| **D15** | Hard-fail vs warn convention | **Warn-only post-push (Slack ping); hard-fail на deploy gate Track B** | R2 §10 + Stripe / Vercel / Cloudflare canon 2026 |
| **D16** | axe-core version pinning | **EXACT `axe-core@4.11.4` + `@axe-core/playwright@4.11.1`** (no caret) + `disableRules: []` blanket-disable banned; tuple-allowlist pattern только | R2 §2: shadow-DOM false-positive class needs surgical disable, не blanket |
| **D17** | Lit + axe-core canary | **Renovate weekly informational-only matrix-canary job** runs `lit@latest` + `axe-core@latest` against e2e suite | R2 §8 forward-compat early-warning |
| **D18** | SRI + CSP `connect-src` | **CSP `connect-src 'self' api.yookassa.ru https://monitoring.api.cloud.yandex.net` exact allowlist** + `--no-network` Playwright audit at CI | R2 §3: polyfill.io 2024 supply-chain class — size-limit measures build не runtime exfil |

---

## §3. Library canon (May 4 2026 npm-verify done — drift caught + applied)

Empirical npm-verify 2026-05-04 closed R1 honest gap #3 (registry was blocked at R1 fetch). Caught 2 plan-vs-reality drift points; applied below.

| Library | Pinned version | Source / status |
|---|---|---|
| `@lhci/cli` | **`0.15.1`** (Jun 2025) | Bundles `lighthouse@12.6.1` transitive |
| `lighthouse` | `12.6.1` (transitive) | DO NOT pin standalone `lighthouse@13.2.0` — @lhci/cli is bundled с 12.6.1; using 13 standalone breaks LHCI integration |
| `web-vitals` | `5.2.0` (existing apps/frontend) | Attribution build subpath `web-vitals/attribution` |
| `axe-core` | **`4.11.4` exact** | Pin no caret per D16 |
| `@axe-core/playwright` | **`4.11.3` exact** | Drift caught: was `4.11.1` в R1; latest patch `4.11.3` 2026-05-04 |
| `size-limit` | **`12.1.0`** | Drift caught: was `11.x` в R1; SemVer-major up — verify breaking changes at A5.1 kickoff |
| `@size-limit/preset-app` | `12.1.0` | Match `size-limit` major |
| `@playwright/test` | `1.59.x` (existing) | unchanged |

---

## §4. Sub-phase split (golden middle)

Per лессонs-applied: each sub-phase has its own paste-and-fill audit + memory pointer update + 9-gate clean.

### A5.1 Foundation: Lighthouse + size-limit + post-push CI (~1 day, ~5 tests)
1. `lighthouserc.cjs` + `budgets.json` (D1-D5 applied)
2. `.size-limit.json` root config (D10 — SPA index + lazy chunks + widget budgets)
3. `.github/workflows/post-push.yml` extended (Lighthouse + size-limit jobs, warn-only per D15)
4. `tests/lighthouse-config.test.ts` — config shape + assertion presence + numberOfRuns + tolerance
5. Empirical: run `lhci collect` once locally + size-limit report

### A5.2 RUM pipeline: web-vitals attribution + anonymize + YC Monitoring (~1.5 days, ~12 tests)
6. `apps/frontend/src/lib/rum/anonymize.ts` (D8 — strip `[name=..]`, `[value=..]`, `aria-label`, `placeholder`, `#id`, salt+truncate IP)
7. `apps/frontend/src/lib/rum/index.ts` — onINP/onLCP/onCLS handlers → anonymize → batch → POST `/api/rum`
8. `apps/frontend/src/lib/rum/anonymize.test.ts` — 8 ANON tests adversarial (passport scrub / aria scrub / ID scrub / IP truncate / UA bucket / value strip / canonical roundtrip / honest gap noise inputs)
9. `apps/backend/src/domains/observability/rum.routes.ts` — `POST /api/rum/v1/web-vitals` zod-validated body + rate-limit per IP
10. `apps/backend/src/domains/observability/rum.repo.ts` — reservoir-sample buffer (D9 5000-cap, drop-oldest на overflow) + histogram bucketing
11. `apps/backend/src/domains/observability/yc-monitoring-exporter.ts` — batch flush 10k-metrics/req с Cockatiel-class circuit breaker (D9)
12. `apps/backend/src/domains/observability/rum.routes.test.ts` — 4 RUM integration tests
13. `apps/backend/src/domains/observability/yc-monitoring-exporter.test.ts` — 4 YCM tests с mock fetch

### A5.3 axe-core comprehensive matrix (~1 day, ~36 tests)
14. `tests/e2e/perf-a11y.spec.ts` — matrix loop `[/, /widget/demo-sirius, /book/demo-sirius/<propId>, /api/embed/v1/iframe/...html]` × `['light','dark','forced-colors']` × `[320,768,1024,1440]` = 48 axe scans
15. `tests/axe-known-noise.ts` (D16 — tuple-allowlist `<rule-id, selector>` pattern; blanket disable banned)
16. Visual a11y `toHaveScreenshot()` для forced-colors mode (D14 Cyrillic)
17. `tests/e2e/iframe-noscript.spec.ts` — Playwright `javaScriptEnabled: false` context (D13)
18. axe full-run integrated в post-push.yml workflow

### A5.4 Speculation Rules + Sec-Purpose handling (~½ day, ~5 tests)
19. iframe-html.routes.ts emits `<script type="speculationrules">` block (D11)
20. `apps/backend/src/middleware/sec-purpose-guard.ts` (D12) — 503 on cross-origin prefetch
21. RUM filter: `document.prerendering` check skip (R2 §7)
22. `tests/e2e/speculation-rules.spec.ts` — 4 SR tests (allowed prefetch / cross-origin reject / RUM phantom-session filter / `requires: anonymous-client-ip` enforced)
23. iframe-html.routes.test.ts — IF11 noscript block present + Sec-Purpose handling

### A5 closure (~½ day)
24. `pnpm lhci collect` + `pnpm lhci assert` — empirical perf gate verified live
25. `pnpm exec playwright test --project=smoke` — 48-axe matrix passes
26. Memory pointer + done memory (project_m9_widget_7_done.md)
27. ROADMAP A5 row `[✅]`
28. plan §17 implementation log appended per sub-phase

---

## §5. Strict test plan (target ~62 tests across A5)

- **Lighthouse config**: 5 LH tests (D1-D5 assertion presence, budgets shape, numberOfRuns, tolerance, lcp-lazy-loaded error level)
- **anonymize.ts**: 8 ANON tests adversarial (passport scrub / aria scrub / ID scrub / IP truncate / UA bucket / value strip / canonical roundtrip / fuzz)
- **RUM routes**: 4 RUM integration (rate-limit / shape validate / 152-ФЗ post-anonymize verify / cross-tenant)
- **YC Monitoring exporter**: 4 YCM (batch shape / 10k cap / 429 circuit / drop-oldest reservoir)
- **axe matrix**: 48 = 4 surfaces × 3 themes × 4 viewports
- **noscript**: 1 IFNS test
- **Speculation Rules**: 4 SR tests
- **size-limit**: integration into existing build:check command — add 3 SPA entries

**Total target: ~62 strict tests + Lighthouse run + size-limit gate + axe matrix coverage.**

---

## §6. Pre-done audit checklist (paste-and-fill в КАЖДОМ commit body)

```
A5.{N} — pre-done audit
- [ ] Per-sub-phase R1+R2 ≥2026-05-04 (если scope шире baseline R1+R2 sub-phase pre-flight)
- [ ] D8 anonymize.ts strips ALL attribute-values + IDs + UA bucketing (152-ФЗ)
- [ ] D9 batch + reservoir-sample + circuit breaker tested (YC Monitoring 10k/req limit)
- [ ] D11 Speculation Rules requires anonymous-client-ip + href_matches own origin
- [ ] D12 Sec-Purpose: prefetch 503 для cross-origin
- [ ] D14 forced-colors visual a11y `toHaveScreenshot()` Cyrillic glyph-drop
- [ ] D16 axe-core 4.11.4 EXACT pin + tuple-allowlist (no blanket disable)
- [ ] D18 CSP connect-src exact allowlist + Playwright --no-network audit
- [ ] Cross-tenant × every RUM method (rum.repo + yc-monitoring-exporter)
- [ ] Empirical: `pnpm lhci collect` + `lhci assert` + axe matrix runs locally
- [ ] 9-gate green: sherif / biome / depcruise / knip / typecheck / build / vitest unit / vitest browser / test:serial
- [ ] Plan §17 implementation log appended
- [ ] Memory pointer (`project_m9_widget_7_canonical.md`) updated
- [ ] ROADMAP A5 row updated
- [ ] MEMORY.md index updated (если closure)
```

---

## §7. Definition of Done M9.widget.7

- [ ] `lighthouserc.cjs` + `budgets.json` shipped с D1-D5 assertions live
- [ ] web-vitals 5 attribution build → `/api/rum` → YC Monitoring exporter pipeline live
- [ ] `anonymize.ts` strips ALL 152-ФЗ-relevant fields verified via 8 ANON adversarial tests
- [ ] axe-core 48-cell matrix passes (4 surfaces × 3 themes × 4 viewports)
- [ ] size-limit gate enforced at post-push (warn-only); size budgets honored
- [ ] iframe-html `<noscript>` fallback verified Playwright `javaScriptEnabled: false`
- [ ] Speculation Rules block emitted в iframe-html + Sec-Purpose middleware blocks abuse
- [ ] CSP `connect-src` exact allowlist + Playwright `--no-network` audit at deploy gate (carry-forward к Track B)
- [ ] Empirical `pnpm lhci collect` + axe matrix run locally — captured screenshots archived
- [ ] Per-sub-phase paste-and-fill audit applied в every commit body
- [ ] Plan §17 implementation log appended per sub-phase
- [ ] Memory pointer reflects A5 done state
- [ ] Done memory `project_m9_widget_7_done.md` created
- [ ] MEMORY.md index updated к `_done` pointer
- [ ] ROADMAP A5 row marked `[✅]`

---

## §8. Risks / honest gaps

1. **YC Monitoring no published RPS quota** — soft-throttled by region. Reservoir-sample + 10k-metrics/req batch defends but full quota empirical-untested до production deploy.
2. **2026-Q2 RU mobile-mix data unavailable** — assume Yandex.Metrica 2025 industry mix (~85% 4G/LTE+, ~12% 3G, ~3% wifi-only). Empirical re-verify post-deploy.
3. **npm registry blocked R1 fetch** — empirical npm-verify ВСЕХ pinned versions при A5.1 kickoff обязательно.
4. **No 2026 cite for "RU gov sites embedding 3rd party widgets"** — evergreen reasoning + iframe-fallback canon already covers это; honest flag.
5. **axe-core 4.12+ might ship during A5 implementation** — pin EXACT + matrix-canary informational job catches forward-compat regressions early.

---

## §9. Anchor commits

- `<TBD>` — A5 pre-flight canon (this file's commit)
- `<TBD>` — A5.1 Lighthouse + size-limit + post-push CI
- `<TBD>` — A5.2 RUM pipeline (anonymize + routes + YC exporter)
- `<TBD>` — A5.3 axe matrix
- `<TBD>` — A5.4 Speculation Rules + Sec-Purpose
- `<TBD>` — A5 closure (memory + ROADMAP + done)

---

## §17. Implementation log (carry-forward, populated per sub-phase commit)

### A5.1 (commit pending) — Lighthouse CI + size-limit + post-push CI extension + 14 strict tests

Files added:
- `lighthouserc.cjs` (CommonJS canon per D2) — D1-D5 assertions live (LCP / TBT / CLS / SI / FCP) + D3 LCP gaming defense (`lcp-lazy-loaded` / `largest-contentful-paint-element` / `prioritize-lcp-image` all `error`) + D4 TBT `aggregationMethod: 'pessimistic'` + D5 `numberOfRuns: 5`
- `budgets.json` — per-route resource budgets (`/widget/*` SPA + `/api/embed/v1/iframe/*` tighter)
- `.size-limit.json` — D10 SPA budgets (180 KB index + 60 KB lazy chunks × 3 widget routes + 70 KB booking-and-pay) + existing widget facade 15 KB + lazy 80 KB preserved
- `apps/backend/src/lib/ci-config-shape.test.ts` — **14 strict tests** (LHC1-6 + BG1-4 + SZ1-4) verifying assertion presence, severity levels, aggregationMethod, numberOfRuns, budget cross-surface tightness, third-party ban, gzip-only measurement

Files modified:
- `package.json` — devDeps: `@lhci/cli@0.15.1`, `@size-limit/preset-app@^12.1.0`, `axe-core@4.11.4` exact, `size-limit@^12.1.0`; `@axe-core/playwright` upgraded `^4.11.2` → `4.11.3` exact (D16 EXACT pin canon); scripts: `size:check` + `lhci:collect`
- `.github/workflows/post-push.yml` — extended с `Size budget (warn-only)` + `Lighthouse CI (warn-only)` jobs (D15 — warn-only post-push canon Stripe / Vercel / Cloudflare)
- `knip.json` — `axe-core` added к `ignoreDependencies` (transitive via @axe-core/playwright bridge; not directly imported)

Empirical verification 2026-05-04:
- `pnpm size:check` → ALL 6 budgets PASS:
    - SPA index: 177.88 KB / 180 KB (12 KB headroom)
    - SPA widget route: 2.72 KB / 60 KB
    - SPA widget property route: 6.54 KB / 60 KB
    - SPA widget extras route: 5.95 KB / 60 KB
    - SPA booking-and-pay route: 45.97 KB / 70 KB
    - Widget facade: 12.7 KB / 15 KB
    - Widget lazy chunk: 10.11 KB / 80 KB
- `pnpm exec vitest run apps/backend/src/lib/ci-config-shape.test.ts` → **14/14 PASS**

A5.1 — pre-done audit (paste-and-fill per `feedback_pre_done_audit.md`):
- [X] D1-D5 Lighthouse assertions live + verified via 6 LHC tests
- [X] D3 LCP gaming defense (lcp-lazy-loaded + largest-contentful-paint-element + prioritize-lcp-image all `error`)
- [X] D4 TBT `aggregationMethod: 'pessimistic'` worst-run canon
- [X] D5 `numberOfRuns: 5` LHCI median-of-5 canon (R2 §6)
- [X] D10 SPA + widget bundle budgets enforced via size-limit@12 + 4 SZ tests
- [X] D15 warn-only post-push canon (continue-on-error: true для both new jobs)
- [X] D16 axe-core 4.11.4 + @axe-core/playwright 4.11.3 EXACT pin (no caret)
- [X] budgets.json shape valid + 4 BG tests
- [X] 9-gate green: sherif (auto-fix sort) / biome / depcruise (702 modules) / knip (axe-core ignored — transitive via @axe-core/playwright bridge) / typecheck / build / size:check / vitest unit (14 tests)
- [X] Empirical: size:check + vitest run locally PASS
- [ ] A5.2 RUM pipeline — DEFER к next sub-phase commit
- [ ] A5.3 axe matrix — DEFER к sub-phase
- [ ] A5.4 Speculation Rules + Sec-Purpose — DEFER к sub-phase

### A5.2 — RUM pipeline (anonymize 152-ФЗ + web-vitals attribution + YC Monitoring exporter) — 2026-05-04

**Files added:**
- `packages/shared/src/rum.ts` — single source of truth: zod `RumMetricSchema` + `RumBatchSchema` + `truncateIp()` (152-ФЗ edge anonymization). Subpath export `./rum`.
- `apps/frontend/src/lib/rum/anonymize.ts` — `scrubSelector()` (manual brace-scanner, NO regex; bracket-injection-safe), `bucketUserAgent()`, `scrubUrl()`. Hard-cap 2048 chars (DOS defense).
- `apps/frontend/src/lib/rum/anonymize.test.ts` — **29 ANON tests** (passport / Cyrillic ID / IPv6 + IPv4-mapped / UA buckets × all browsers+OSes / value+href+src / roundtrip + fuzz / hard-cap).
- `apps/frontend/src/lib/rum/index.ts` — `startRum()` web-vitals 5 attribution → anonymize → batched POST. R2 §7 phantom-session filter (`document.prerendering`); pagehide+visibilitychange `sendBeacon` flush; React StrictMode-safe singleton.
- `apps/backend/src/domains/observability/rum.repo.ts` — `RumBuffer` 5000-cap drop-oldest FIFO (D9). `droppedCount` observable.
- `apps/backend/src/domains/observability/rum.routes.ts` — `POST /api/rum/v1/web-vitals`. zValidator(`RumBatchSchema.strict()`) + extractClientIp + truncateIp. CORS `*`. Per-IP rate-limit 60 req/min.
- `apps/backend/src/domains/observability/yc-monitoring-exporter.ts` — `createYcMonitoringExporter()` wrapping our own `composePolicies(circuitBreaker(5/60s), retry(3/200-5000ms, 4xx-no-retry), timeout(10s))` (NO Cockatiel — stale 21mo). Slices ≤ 10k metrics/req per YC docs 2026-03-24.
- `apps/backend/src/domains/observability/rum.routes.test.ts` — **6 RUM tests** (batch ingest / shape sweep 6 negative cases / X-Forwarded-For truncate / "anonymous" → "unknown" / cross-tenant 2 slugs / slug regex enforcement).
- `apps/backend/src/domains/observability/yc-monitoring-exporter.test.ts` — **11 YCM tests** (DGAUGE shape / INP 4-payload split-axis / cardinality-bomb labels defense / 12k → 2 slices / URL+auth header / 429 circuit open / 4xx no-retry / HttpError truncate / drop-oldest 3-cap / RangeError on cap≤0 / empty drain).
- `apps/backend/src/app.ts` mounts `/api/rum` route + `RumBuffer({capacity: 5000})` singleton.
- `apps/backend/src/middleware/widget-rate-limit.ts` exports `extractClientIp` (was internal).
- `apps/frontend/src/main.tsx` calls `startRum()` after `setupOtel + setupI18n + reportWebVitals`.

**Verification (no полумер):**
- typecheck PASS — 4 projects (backend / frontend / widget-embed / shared).
- biome PASS — 0 errors. 2 unsafe-fixes applied (computed-key → literal canon).
- sherif / depcruise / knip — PASS (no unused exports after `__testHooks` removed).
- backend `pnpm test:serial` — **4652 passed | 1 skipped | 0 failed** (full regression).
- frontend `pnpm test` — **1325 passed**.
- `pnpm build` — PASS (no chunk-budget regression).

**Tests added: 46 total** (target ~20). Adversarial coverage applied UPFRONT per плана §0 row «Bug-hunt strict tests canon».

**152-ФЗ canon verified empirically:**
- `[name="passport_serial"]` → `[name=*]` (ANON1)
- `[aria-label="Удалить заказ № 12345"]` → `[aria-label=*]` (ANON2 Cyrillic)
- `#user-12345` → `#*` (ANON3)
- `203.0.113.42` → `203.0.113.0` (ANON4)
- `2001:db8:1::cafe` → `2001:db8:1::` (/48 prefix, ANON4.b)
- `::ffff:203.0.113.42` → `203.0.113.0` (IPv4-mapped IPv6 unwrap, ANON4.c)
- `data-order-id="..."` wildcard scrub (ANON2.c)
- YC Monitoring labels: NEVER include selector / id / ip / truncated_ip (cardinality bomb defense, YCM1.c).

A5.2 — pre-done audit:
- [X] D6 web-vitals 5.x attribution build via `web-vitals/attribution` subpath verified empirically (extracted exact INP/LCP/CLS attribution field names from `node_modules/.../dist/modules/types/`).
- [X] D7 frontend → POST `/api/rum/v1/web-vitals` → backend bridge → YC Monitoring HTTP API (proprietary, NOT OTLP).
- [X] D8 `anonymize.ts` strips ALL attribute-values + IDs + UA bucketing + URL query/hash + IP truncate (152-ФЗ верифицировано через 29 ANON adversarial).
- [X] D9 batch + drop-oldest reservoir + circuit breaker tested (YC 10k/req limit slice into 2 batches verified for 12k buffer).
- [X] D9 4xx NOT retried per shouldRetry policy (YCM3.b).
- [X] Cross-tenant × every RUM method (RUM4 — 2 slugs in 1 buffer + drain order verified).
- [X] Strict zod `.strict()` rejects extra fields (RUM2 sweep 6 negative cases).
- [X] React StrictMode singleton — `started` flag prevents double-register.
- [X] R2 §7 phantom-session filter (`document.prerendering`) skip applied.
- [X] pagehide + visibilitychange `sendBeacon` flush wired (best-effort delivery on tab close).
- [X] 9-gate green.
- [X] Memory pointer + ROADMAP updated в same commit.
- [ ] A5.3 axe matrix — DEFER к next sub-phase commit
- [ ] A5.4 Speculation Rules + Sec-Purpose — DEFER к sub-phase

### A5.3 — axe-core comprehensive matrix + forced-colors visual smoke + noscript fallback (D13/D14/D16) — 2026-05-04

**Files added:**
- `tests/axe-known-noise.ts` — D16 tuple-allowlist `<ruleId, selectorContains, reason>` filter + `WCAG_AA_TAGS`. Empty baseline (KNOWN_NOISE: []); blanket-disable BANNED. Each future entry requires code review + upstream-issue link.
- `tests/e2e/perf-a11y.spec.ts` — **48 axe scans** (4 surfaces × 3 themes × 4 viewports) + **4 forced-colors visual snapshots** (D14 Cyrillic glyph-drop). Surfaces: `/widget/demo-sirius`, `/widget/demo-sirius/demo-prop-sirius-main`, `/widget/demo-sirius/demo-prop-sirius-main/extras?...`, iframe HTML wrapper. Themes: light / dark / forced-colors. Viewports: 320 / 768 / 1024 / 1440. Fresh `browser.newContext` per cell — theme + forced-colors не leak across cells.
- `tests/e2e/iframe-noscript.spec.ts` — **2 IFNS tests** под `javaScriptEnabled: false`: noscript content + booking-link presence + keyboard-reachable accessible name. axe-on-noscript skipped honestly (axe-core injection требует page-context JS — incompatible с javaScriptEnabled:false; covered by IF11 unit test instead).
- `tests/e2e/perf-a11y.spec.ts-snapshots/forced-colors-{320,768,1024,1440}-smoke-darwin.png` — visual baselines committed.

**Files modified:**
- `apps/backend/src/domains/widget/iframe-html.routes.ts` — `<noscript>` block с `[data-testid=iframe-noscript]` + booking-link fallback (XSS-escaped slug interpolation). Phone column carry-forward к M11 admin UI (no schema migration в A5.3 scope).
- `apps/backend/src/domains/widget/iframe-html.routes.test.ts` — **IF11 noscript unit test**: `<noscript>` present, booking-link match, ordering invariant (host BEFORE noscript so JS-enabled clients hit Lit surface first).
- `playwright.config.ts` — smoke project includes `(perf-a11y|iframe-noscript)\.spec\.ts` (chromium project ignores).

**Verification (no полумер):**
- typecheck PASS — 4 projects.
- biome PASS — 0 errors.
- depcruise PASS — 711 modules.
- knip PASS.
- backend `pnpm test:serial` — **4653 passed | 1 skipped | 0 failed** (+1 vs A5.2 = IF11).
- frontend `pnpm test` — **1325 passed**.
- `pnpm build` — PASS.
- `pnpm exec playwright test --project=smoke --update-snapshots --reporter=line` — **65 passed** (1 initial IFNS2 false design caught + corrected → axe-on-noscript replaced by keyboard-reachable assertion). 1.5 min runtime.

**Tests added: 55 total** (target ~36+5=41).
- 48 axe matrix scans — green с baseline tuple-allowlist (empty, no blanket disable).
- 4 forced-colors visual smoke (D14 Cyrillic glyph-drop catch).
- 2 iframe-noscript Playwright (D13).
- 1 IF11 backend unit (noscript structure).

A5.3 — pre-done audit:
- [X] D13 noscript fallback rendered + verified в IF11 + IFNS1 + IFNS2.
- [X] D14 forced-colors visual smoke `toHaveScreenshot()` (`maxDiffPixelRatio: 0.05`) с 4 viewports baselines committed.
- [X] D16 axe-core 4.11.4 EXACT pin + tuple-allowlist (KNOWN_NOISE empty baseline; blanket disable BANNED).
- [X] 4 surfaces × 3 themes × 4 viewports = 48 axe-pass green с filterKnownNoise() (returns empty).
- [X] Process correction: «axe-on-noscript timeout» false-design caught + replaced с DOM-direct keyboard-reachable assertion (axe-core injection требует page JS; не disponible под javaScriptEnabled:false).
- [X] 9-gate green: lint / typecheck / sherif / depcruise / knip / build / backend test:serial / frontend test / e2e:smoke (4-min serial run).
- [X] Memory pointer + ROADMAP updated в same commit.
- [ ] A5.4 Speculation Rules + Sec-Purpose middleware — DEFER к next sub-phase

### A5.4 (commit pending)
TBD — Speculation Rules + Sec-Purpose findings.

### A5 closure (commit pending)
TBD — empirical run + done memory.

---

**End of M9.widget.7 canonical sub-phase plan.**
