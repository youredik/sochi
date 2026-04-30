# Sochi PMS — ROADMAP (single source of truth)

**Дата:** 2026-04-30
**Уровень:** track + phase (выше per-phase plan canon'ов вроде `m9_widget_canonical.md`)
**Цель файла:** persistence между сессиями. Если ты или я возвращаемся после паузы — этот файл отвечает на «что строим, где остановились, что дальше».
**Supersedes:** Roadmap-таблицы в `project_north_star_canonical.md` и `project_initial_framing.md` (они теперь pointer'ы сюда).

---

## Сейчас работаем над

**Track A3 — M9.widget.5 Confirmation** (NEXT). Pre-flight pending — `plans/m9_widget_5_canonical.md` ещё НЕ написан. Первый шаг next-session = full pre-flight (R1+R2+R3+stankoff+npm verify) по pattern'у `m9_widget_4_canonical.md`.

**M9.widget.4 (A2 Guest+Pay) DONE 2026-04-30** — `project_m9_widget_4_done.md`. Final origin/main HEAD: **`456a591`**. Sub-phase + post-push infrastructure epic landed (12 commits). Включая:
- 65 unit + integration tests + 10 E2E + axe 4-theme matrix
- Backend port 3000→8787, frontend 5173→5273 (coexist с stankoff-v2)
- Pre-push gate 250s → ~5s (vitest fully delegated к async self-hosted runner)
- 5 new memory canons (no_disrupt_other_dev / foreground_runs / pre_push_strategy / inter_project_port_allocation + cross-links)

**A3 scope** (per Track A row + `m9_widget_canonical.md` §M9.widget.5):
- magic-link service (jose 6.2.3, HS256, 24h TTL)
- email voucher template (Postbox/Mailpit factory)
- .ics calendar invite (RFC 5545)
- guest portal (passport completion для D9 placeholder из widget.4)

**Anchor commits (origin/main):**
- `6ccae91` — M8.A done (миграционный учёт МВД closed)
- `e5fb3d3` — M9 done (theming/adaptive/PWA/passkey/visual)
- `fb0c0b1` — M9.widget.2 senior-pass v3 (Screen 1 Search & Pick closed)
- `ff62cb2` — M9.widget.3 senior-pass closure (Screen 2 Extras)
- **`456a591`** — M9.widget.4 closure (Screen 3 Guest+Pay + post-push infra epic)
- `<TBD>` — M9.widget.5 pre-flight canon (next session first commit)

---

## Vision (одной строкой)

Закрыть **6/7 функций** мандата end-to-end на behaviour-faithful Mock'ах с production-grade canon, **deploy на Yandex Cloud** как always-on demo, и под каждого первого production-tenant'a делать **live-flip per-integration** через factory binding (ZERO domain code changes).

7-я функция (3.1 KPI Dashboard) — DataLens external, вне нашего кодового scope (см. `project_dashboard_external.md`).

---

## Архитектурный canon (already in place)

- ✅ Adapter registry singleton (`apps/backend/src/lib/adapters/registry.ts`) с `assertProductionReady()` gate + Mock-whitelist
- ✅ Migration `0042_organization_profile_mode.sql` — поле `mode='demo' | 'production'` на orgProfile
- ✅ `middleware/demo-lock.ts` — destructive-ops blocker для demo-тенантов
- ✅ `db/seed-demo-tenant.ts` — seeder script (нужен polish в Track A6)
- ✅ Behaviour-faithful Mock'и: `mock-epgu.ts`, `mock-vision.ts`, `stub-provider.ts` (payment), Postbox factory (Postbox/Mailpit/Stub)

**Caveat:** Mock'и написаны по research-cache, **empirical-verification отложена** в Track C (когда creds появятся). Disclaimer per `feedback_empirical_mock_verification.md` в commit messages обязателен до alignment.

---

## Track A — Demo Surface Completion (critical path)

| # | Фаза | Закрывает | Key deliverable | Strict tests | Plan canon |
|---|---|---|---|---|---|
| **A1** ✅ | M9.widget.3 — Extras / Addons | Боль 2.3 (continuing) | Screen 2 inline addon cards + Skip CTA + axe AA | **107 strict + 13 E2E** (target was ~25; expanded после Round 2 compliance findings) | `m9_widget_canonical.md` §3 |
| **A2** ✅ | M9.widget.4 — Guest + Pay | Боль 2.3 (continuing) | TanStack Form + 152-ФЗ + 38-ФЗ consents + Stub canonical interface + rate-limit + migration 0045 (consentLog) — closed `456a591` | **65 unit + integration + 10 E2E + 4-theme axe** | §4 + done memory |
| **A3** | M9.widget.5 — Confirmation | Боль 2.3 (continuing) | magic-link service (jose 6.2.3, HS256) + email voucher (Postbox/Mailpit) + .ics + guest portal | ~45 | §5 |
| **A4** | M9.widget.6 — Embed Web Component | Боль 2.3 (closure) | `apps/widget-embed` Vite build → Lit 3.3.2 + Declarative Shadow DOM SSR + iframe fallback ≤30 kB gzip | ~30 | §6 |
| **A5** | M9.widget.7 — Perf + a11y gate | Quality canon | Lighthouse CI 0.15.1 pre-push + INP attribution + axe matrix expansion (4 themes × widget routes) | ~15 | §7 |
| **A6** | M9.widget.8 — Demo polish | Acquisition surface | Реалистичный «Гостиница Сириус» seed (24 номера, 30+ бронирований, photos, JSON-LD Schema.org Hotel) + 24h refresh cron + landing с tour-указателями | ~25 | §8 |
| **A7** | M10 — Channel Manager Mock | Боль 2.2 (closure) | TravelLine + Я.Путешествия + Ostrovok behaviour-faithful Mock'и + canonical adapter interface + двусторонняя sync визуально на demo | ~80 | TBD `plans/m10_canonical.md` (создать перед стартом) |

### Track A DoD

- ☐ 6/7 функций end-to-end на Mock'ах (1.1 / 1.2 / 2.1 / 2.2 / 2.3 / 3.2)
- ☐ Все Mock'и пишут canonical interface правильно с первого раза (live-swap = factory binding only)
- ☐ 9-gate pipeline зелёный: sherif / biome / depcruise / knip / typecheck / build / test:serial / smoke / e2e:smoke + axe AA + Lighthouse gate
- ☐ Pre-done audit checklist paste-and-fill в каждом sub-phase commit
- ☐ Coverage floor bump до 50/55/40/50 после M9.widget closure (per `m9_widget_canonical.md` §10)
- ☐ Demo seeder показывает all 7×3 surfaces с realistic data

---

## Track B — Deploy Infra (после Track A)

| # | Фаза | Deliverable | Reference |
|---|---|---|---|
| **B1** | SourceCraft + GitHub mirror | OIDC Service Connection, lift-and-adapt `.sourcecraft/ci.yaml` от stankoff-v2 | `project_deferred_deploy_plan.md` §SourceCraft |
| **B2** | Terraform infra | 11 файлов lift-and-adapt от stankoff-v2 (drop CDC + postbox + smartcaptcha defer) + 0-3 sochi-specific | `project_deferred_deploy_plan.md` §TF |
| **B3** | Yandex Cloud topology | Object Storage SPA + CDN + API Gateway + Serverless Container `min_instances=0` + LE cert + Lockbox secrets | `project_deferred_deploy_plan.md` §topology |
| **B4** | PWA enable | vite-plugin-pwa 1.2.0 injectManifest + Workbox NetworkFirst grid + BackgroundSync mutations | `project_deferred_deploy_plan.md` §PWA |
| **B5** | Public domain + ENV | RU domain `.ru` (Reg.ru/Beget) + `APP_MODE=production` + `APP_MODE_PERMITTED_MOCK_ADAPTERS` whitelist (canonical для demo-тенантов) | — |
| **B6** | Demo refresh cron в проде | Cloud Scheduler → Cloud Function → call demo-seeder-reset endpoint каждые 6h | `project_demo_strategy.md` §refresh |
| **B7** | 152-ФЗ baseline для prospect'ов | privacy-policy.md page + cookie consent + согласие на обработку для public widget | M9.widget.4 carry-forward |

### Track B DoD

- ☐ `https://<domain>` загружает demo PMS, prospect видит «Гостиница Сириус» с realistic data за 0 секунд
- ☐ Виджет embed работает на любом стороннем сайте через `<sochi-booking>` тег
- ☐ Demo refresh cron не падает 7 дней подряд (`/health/demo` зелёный)
- ☐ Yandex Metrika собирает funnel events
- ☐ Бюджет YC ~3200 ₽/mo (Y1 grant tier per `project_deferred_deploy_plan.md`)

**Pre-Track-B re-verify obligation:** `project_deferred_deploy_plan.md` 5+ дней old. Перед B1 — re-check SourceCraft pricing + Yandex provider versions + LHCI canonical pair.

---

## Track C — Live-Adapter Readiness (parallel, opportunistic)

**НЕ блокер для Track A/B.** Делается когда creds естественным путём появляются (юр-лицо открыто, integration agreements подписаны, prospect готов конвертироваться).

| # | Сервис | Pre-condition | Empirical-curl + alignment |
|---|---|---|---|
| **C1** | Yandex Vision live | YC_API_KEY (SA с `ai.vision.user` role) + folder ID | `scripts/verify-vision-empirical.ts` ready; resolve 9-vs-12 entity divergence |
| **C2** | ЮKassa live | Test shop_id + sandbox secret (24h registration в ЛК ЮKassa); ngrok для webhook | `POST /v3/payments` + 54-ФЗ Чеки с `vat_code=11` НДС 22% + IP allowlist webhook verify |
| **C3** | Postbox live | YC SA `postbox.sender` role + `.ru` sender domain + DKIM CNAME/TXT verify + production-access ticket | `SendEmail` через `@aws-sdk/client-sesv2` + DKIM mailheader inspection |
| **C4** | Channel Manager live | Per-channel partner agreements (TravelLine/Я.Путешествия/Ostrovok dev-account) | M10-aligned per-channel |
| **C5** | **M8.B — Скала-ЕПГУ + КриптоПро** | (a) ИП/ООО открыто, (b) КриптоПро CSP commercial license + JaCarta token (~2500 ₽/tenant), (c) МВД ОВМ onboarding agreement (multi-week process) | Делается **только под конкретного первого production-tenant'a** |

### Track C DoD (per-adapter)

- ☐ Empirical evidence файл в `apps/backend/src/domains/<domain>/_evidence/<adapter>-real-response.json`
- ☐ Mock alignment commit с reference на evidence
- ☐ Live adapter implementation passing same canonical interface tests
- ☐ Factory-binding flip-switch tested: `tenant.mode='production'` resolves live, не Mock

---

## Глобальный DoD (когда говорим «demo в свет»)

После Track A + Track B всё это должно быть зелёным:

1. ☐ 6/7 функций end-to-end demonstratable на Mock'ах (1.1 / 1.2 / 2.1 / 2.2 / 2.3 / 3.2)
2. ☐ Public URL: prospect заходит → видит живой PMS за 0 секунд
3. ☐ Widget embed: `<sochi-booking tenant-slug="sirius">` работает на demo-странице на сайте
4. ☐ ЮKassa Stub processes test payment до Confirmation screen
5. ☐ Magic-link email (через Postbox real или sandbox) приходит prospect'у
6. ☐ Demo refresh cron восстанавливает golden state каждые 6h
7. ☐ Channel Manager Mock показывает фейковую sync с TravelLine/Я.Путешествия/Ostrovok
8. ☐ axe WCAG 2.2 AA pass на all surfaces (admin + widget + landing)
9. ☐ Lighthouse CI gate green (LCP ≤2.5s / INP ≤200ms / CLS ≤0.1 / Bundle ≤30 kB widget)
10. ☐ Production startup gate (`assertProductionReady`) проходит с whitelist для demo Mock'ов
11. ☐ Yandex Metrika собирает funnel events
12. ☐ 152-ФЗ согласие + privacy-policy на public путях

---

## Sequencing diagram

```
NOW ──► A1 (widget.3 Extras) ──► A2 (widget.4 Guest+Pay)
                                        │
                                        ├─► A3 (widget.5 Confirmation)
                                        │
                                        ├─► A4 (widget.6 Embed Web Component)
                                        │
                                        ├─► A5 (widget.7 Perf+a11y gate)
                                        │
                                        └─► A6 (widget.8 Demo polish)
                                                        │
                                                        ▼
                                                   A7 (M10 Channel Mgr)
                                                        │
                                                        ▼
                                            B1-B7 (Deploy Track)
                                                        │
                                                        ▼
                                                  ✦ DEMO LIVE ✦
                                                        │
                                                        │  (parallel anytime when creds appear)
                                                        ▼
                                                  C1-C5 (Live adapters)
                                                        │
                                                        ▼
                                              First production tenant flip
```

---

## Carry-forward TODO

- **M10 plan canon** — создать `plans/m10_canonical.md` на баре `m9_widget_canonical.md` перед Track A7 (4-6 раундов research + npm verify + sub-phase decomposition)
- **M9.widget §carry-forward** (status 2026-04-30 после A2 closure):
  - ✅ ПП РФ №1912 от 27.11.2025 — wording embedded в widget.4 sticky-summary cancellation copy + addon disclosure (verified)
  - ✅ 152-ФЗ wording 2025-09-01 separate-doc — embedded в widget.4 consent-texts.ts v1.0 (verified, separate-doc canon enforced)
  - 🟡 Yandex SmartCaptcha v2 — defer Track C2 confirmed (rate-limit primary в A2; captcha-after-breach pattern)
  - 🟡 РКН реестр операторов ПД — tag для compliance phase (deploy-track B7 «152-ФЗ baseline для prospect'ов»)
  - 🔴 **jose 6.x migration guide** — **verify первым шагом A3** (M9.widget.5 magic-link signing); plan canon `m9_widget_5_canonical.md` step 1 = npm-empirical-verify + R1 research
- **Empirical curl batch Phase 2** — pending creds (Vision / ЮKassa / Postbox) — Track C parallel; turnkey scripts ready (`scripts/verify-vision-empirical.ts` + аналоги)
- **M8.B** — special: only под конкретного первого production-tenant'a, multi-week МВД ОВМ onboarding + КриптоПро commercial license

---

## Risks / honest gaps

- **Mock-fanfic risk**: писать «100% совпадает» по research-cache без empirical curl — нарушает `feedback_empirical_mock_verification.md`. Mitigation: каждый Mock в Track A коммитится с disclaimer «behaviour-faithful по research-cache, empirical-verification pending». Track C alignment когда creds придут.
- **Carry-forward от M9.widget plan canon**: 5 unverified carry-forward'ов до A2 (см. выше).
- **Channel Manager research gap**: M10 не имеет canonical plan'а на баре `m9_widget_canonical.md` — нужен 4-6 раундов research перед стартом.
- **Deploy infra cache stale**: `project_deferred_deploy_plan.md` 5+ days old — re-verify pricing/versions перед B1.
- **Cost discipline**: Y1 demo ~3200 ₽/mo (grant tier). Если prospect-traffic превысит CDN/SC лимиты — bump к ~9650 ₽/mo. Acceptable, monitorable через `project_observability_stack.md` budget alerts.

---

## Predicates (как возвращаться после паузы)

### Тебе

1. Этот файл → секция «Сейчас работаем над»
2. `git log --oneline -20` → где остановились
3. Pinned anchor commits (см. сверху)

### Мне (порядок чтения в начале сессии)

1. `MEMORY.md` (auto-loaded)
2. `project_north_star_canonical.md` (canonical FIRST)
3. `project_demo_to_live_roadmap.md` → этот файл
4. Latest `project_m9_widget_<N>_done.md` (current = `_2_done.md`)
5. Per-phase plan canon (`m9_widget_canonical.md` § currently working)

---

## Ongoing-дисциплины (canon уже стоит)

1. **Per-phase done memory** после каждой завершённой sub-фазы — `project_<phase>_done.md` (canon работает: `m8_a_done.md` → `m9_done.md` → `m9_widget_2_done.md`)
2. **Pre-done audit checklist** в каждом commit body (`feedback_pre_done_audit.md`)
3. **Re-verify stale memory** перед стартом большой фазы (особенно Track B)
4. **Update этот файл** при закрытии каждой sub-phase: бамп «Сейчас работаем над» + checkbox в Track A/B/C table + anchor commit hash

---

## Что **не** делаем

- ❌ Sirius-резидентство, Yandex Cloud Boost, грантовые программы (`feedback_no_sirius.md`)
- ❌ Live-адаптеры до того как есть prospect готовый flip'нуться
- ❌ M8.B (КриптоПро commercial license + МВД ОВМ) до первого production-tenant'a
- ❌ Empirical curl как блокер для demo deploy — параллельный track
- ❌ `.claude/`, `CLAUDE.md`, settings в repo (`feedback_no_claude_in_repo.md`)
- ❌ MVP-thinking «потом причешем» — каждая фаза production-grade сразу (`feedback_no_halfway.md`)

---

## Origin

Создано 2026-04-30 после strategic re-alignment session: пользователь корректно указал, что empirical-verification НЕ блокер для demo deploy (это pre-condition для live-flip). Roadmap reframe'нут как 3-track decoupled план: A (demo surface) → B (deploy) → C (live readiness, parallel).

Cf. `project_demo_strategy.md` (always-on demo canonical), `project_north_star_canonical.md` (product north-star).
