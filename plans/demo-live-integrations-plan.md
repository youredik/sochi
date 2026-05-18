# Demo Live-Integrations + Public Deploy — Canonical Plan

**Anchor commit:** `b7e01c9` (main, 2026-05-18, clean tree)
**Research basis:** 3 веб-research'а ≥ 2026-05-18 (Yandex Vision OCR / SMS industry canon / МВД ЕПГУ B2B контур)
**Memory:** `project_demo_live_integrations_plan_2026_05_18`

---

## §0 Codebase recon (state of payment domain, 2026-05-18)

**LIVE-READY (не трогаем):** DaData, Yandex SmartCaptcha, Email Postbox, Yandex Object Storage S3, CDN.

**Payment domain — что есть:**

- `apps/backend/src/lib/adapters/registry.ts` — `payment.stub` mode=`mock` (line 237-244)
- `apps/backend/src/domains/payment/provider/stub-provider.ts` (252 LoC) — `PaymentProvider` interface: `initiate / capture / cancel / refund / verifyWebhook / releaseResidualHold`
- Migrations: `0008_payment.sql` (9 status states), `0010_payment_webhook_event.sql` (dedup PK = `(tenantId, providerCode, dedupKey)`, 30-day TTL), `0015_payment_cdc_consumers.sql`
- `payment.repo.ts` (553 LoC) — full-row UPSERT с version CAS
- `payment.service.ts` (228 LoC) — createIntent orchestration с two-leg transition
- `payment.routes.ts` (105 LoC) — read/write endpoints
- `payment-transitions.ts` — provider-gated SM (SBP forbids `pending→waiting_for_capture`)
- Frontend: `payment-method-selector.tsx` (card/sbp radio)
- 1873 LoC backend tests + 2059 LoC widget tests

**ЮKassa-specific findings (из memory `project_yookassa_canon_corrections.md`):**

- API base: `https://api.yookassa.ru/v3/` (v4 не существует)
- Auth: HTTP Basic `shopId:secretKey`
- Webhook: **NO HMAC** — только IP allowlist (7 CIDRs: `185.71.76.0/27` etc) + optional GET round-trip
- Idempotency header: `Idempotence-Key` (правильное написание!), 64 chars UUIDv4, 24h dedup
- Webhook event dedup key: `${providerPaymentId}|${event}|${status}|${amount}`
- VAT codes 2026: `11` (НДС 22%), `12` (НДС 22/122), accommodation льгота — code `2` до 2030
- Tourism tax Сочи: НЕ отдельной строкой в чеке, в составе accommodation total
- 3DS: redirect через `confirmationUrl` (не iframe post-back)
- `refund.canceled` event НЕ существует — poll `GET /v3/refunds/{id}`
- НЕТ SDK — REST direct через `fetch`

**Blockers для live:**

1. Webhook handler endpoint `/api/v1/payments/webhook/yookassa` — не существует
2. `yookassa-provider.ts` — не написан
3. `env.ts` — нет `YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY / PAYMENT_PROVIDER`
4. Factory conditional binding в `app.ts` — stub hardcoded
5. 3DS redirect callback handler — нет
6. Vision adapter live binding — есть mock, есть curl script ready, но фабрика не написана
7. SMS — `DemoInboxAdapter` только email; нужно расширить на SMS channel

---

## §1 Mission

Закрыть последний gap перед публичным запуском demo. Из 14 внешних сервисов:

- 5 уже LIVE (DaData / Captcha / Email / S3 / CDN)
- 2 поднимаем до LIVE (ЮKassa / Vision) — у обоих есть публичная песочница
- 4 остаются MOCK с явной плашкой (МВД / Channel managers / РКЛ / Archive ГОСТ)
- 1 mock-with-DemoInbox (SMS — industry consensus 2026)

Параллельно Track B deploy на Yandex Cloud. Цель — публичное demo через ~7-10 рабочих дней с минимальной разницей UX от production.

---

## §2 Phases (atomic, `no-halfway` canon)

### P1. ЮKassa live (sandbox) — 3 дня

**P1.1** Env vars + factory binding

- `YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY / PAYMENT_PROVIDER` в `env.ts` (z.string + booleanEnv)
- Conditional factory в `app.ts` — switch stub|yookassa по env
- `.env.example` — placeholders
- Adapter registry `payment.yookassa` mode=`sandbox|live`

**P1.2** `yookassa-provider.ts` — REST direct

- `initiate` → POST `/v3/payments` с `Idempotence-Key` header, return snapshot `{providerPaymentId, status, confirmationUrl, ...}`
- `capture / cancel / refund` — соответствующие POST endpoints
- HTTP Basic auth helper
- In-memory replay cache (как stub) для idempotency
- `verifyWebhook` — IP allowlist validation (7 CIDRs из constants)

**P1.3** Webhook handler `/api/v1/payments/webhook/yookassa`

- IP allowlist middleware
- Dedup key synthesis: `${providerPaymentId}|${event}|${status}|${amount}`
- INSERT в `paymentWebhookEvent` (UNIQUE PK conflict → 200 ack, idempotent replay)
- Closed enum: `payment.waiting_for_capture / payment.succeeded / payment.canceled / refund.succeeded / payout.* / deal.*`
- Apply state transition через `payment.service.applyWebhookEvent()`
- HTTP 200 ack only (no retry codes)

**P1.4** 3DS redirect callback

- Frontend `widget/.../guest-and-pay.tsx` — handle `?paymentId=xxx&yookassa=success|failed` returnUrl params
- Refresh payment state через GET /payments/:id
- Display result page

**P1.5** Strict tests

- `yookassa-provider.test.ts` — mock fetch, cover all 9 status states, idempotency replay, error paths
- `webhook.test.ts` — IP allowlist (positive + adversarial), dedup conflict replay, all event types
- E2E: full happy path booking → ЮKassa sandbox → 3DS → confirmation (Playwright)

**P1.6** Empirical sandbox curl-verify

- Run real test card `5555555555554444` через sandbox endpoint
- Verify webhook arrives и подписывается snapshot canon
- Document timing latency (для honest demo expectation)

**P1.7** Adversarial-reading + Layer 4+5

- 9-item hostile checklist per `feedback_adversarial_reading_before_done`
- Playwright e2e
- axe WCAG 2.2 AA

---

### P2. Yandex Vision live (grant-funded) — 1-2 дня

**P2.1** YC аккаунт + service account + API key

- `YC_VISION_API_KEY` в `env.ts`
- Грант 4 000 ₽ автоматом (60 дней) = 30 000 passport-scan budget
- Factory conditional: `vision.mock | vision.yandex`

**P2.2** `vision-yandex-provider.ts`

- POST `vision.api.cloud.yandex.net/vision/v1/batchAnalyze` с model `passport`
- Auth header `Api-Key <YC_VISION_API_KEY>`
- Token reassembly с confidence threshold (per fuse8.ru canon)
- Map `entities[]` → domain `PassportScanResult` (ФИО / серия / номер / дата рождения)

**P2.3** Strict tests + empirical curl

- Test image fixture (RF паспорт sample)
- Real curl against sandbox, verify response structure stable

**P2.4** Frontend integration в onboarding wizard

- Existing `M8.A.6.passport` (152-ФЗ consent dialog) — swap factory к live
- Loading state 1.5s + error fallback

**P2.5** Layer 4+5

---

### P3. SMS в DemoInboxAdapter — 0.5 дня

Расширение existing `DemoInboxAdapter` canon (commit `d7a6017`) на SMS channel.

**P3.1** Schema extension

- `DemoInboxMessage.channel: 'email' | 'sms'`
- Render UI panel — два tab'а или unified timeline

**P3.2** SMS adapter factory

- `sms.mock` default (capture-only к DemoInbox)
- Production guard: `DEMO_DEPLOYMENT=true` → mock; иначе fail-closed

**P3.3** Tests

- Capture-only verification
- UI panel render

NO real SMS adapter в P3 — отложено до первого платящего клиента (verified-real opt-in по AWS pattern — backlog).

---

### P4. Track B deploy infra на YC — 4-5 дней (параллельно P1+P2)

**P4.1** Pre-Track-B re-verify

- Track A canon 5+ дней old — sanity-run 9-gate pipeline на main
- Verify Track A behaviour-faithful Mocks pass на post-overbooking + chessboard fix codebase

**P4.2** YC infrastructure scaffold

- Serverless Containers definition
- Yandex Object Storage bucket (frontend assets + media)
- Yandex Cloud Postbox SA с `postbox.sender`
- Yandex Cloud Managed YDB (если ещё не — local dev = local docker compose, prod = managed)

**P4.3** Domain + сертификаты

- Покупка домена (например `sochi-pms.ru` или TBD)
- Cloud DNS + Let's Encrypt через YC Certificate Manager
- CDN config для widget embed

**P4.4** CI/CD pipeline

- GitHub Actions → YC Container Registry → Serverless Container deploy
- Health-check endpoint
- Rollback strategy

**P4.5** Demo reset cron

- YC Cloud Functions scheduled trigger (nightly, 04:00 Moscow)
- Truncate demo-tenant write-tables, restore golden seed
- Audit log who reset

**P4.6** APP_MODE startup guard verification

- `APP_MODE=production` rejection if mock adapters (sanity test)
- `APP_MODE_PERMITTED_MOCK_ADAPTERS` whitelist для МВД/Channel/SMS/Archive в demo tenant

---

### P5. Public demo entrance — 0.5 дня

**P5.1** Apaleo-style 1-click entrance

- Main landing → button «Попробовать» → no signup → in работающей «Гостиница Сириус»

**P5.2** Demo banner + CTAs

- Persistent top banner: «Демо-режим — изменения сбрасываются ночью»
- Floating «Перейти на свой тариф» CTA (Navattic 2026: top demos avg 4.7 CTAs ungated)
- Plашка на МВД/Channel manager UI: «Имитация. Реальная отправка после регистрации»

**P5.3** Acquisition funnel basics

- Yandex Metrika подключить (events: demo_start / first_booking / payment_attempt / convert_signup)
- Sentry для errors

---

## §3 Tests matrix (Layer 4+5 per sub-phase)

| Phase                  | Unit (strict) | Backend integration          | Playwright E2E             | axe WCAG 2.2 AA | Empirical curl    |
| ---------------------- | ------------- | ---------------------------- | -------------------------- | --------------- | ----------------- |
| P1.2 yookassa-provider | ✓             | ✓                            | —                          | —               | P1.6              |
| P1.3 webhook           | ✓             | ✓ (IP allowlist adversarial) | —                          | —               | P1.6              |
| P1.4 3DS callback      | ✓             | —                            | ✓ full happy path          | ✓               | —                 |
| P2 Vision              | ✓             | —                            | ✓ scan flow                | ✓               | P2.3              |
| P3 SMS DemoInbox       | ✓             | —                            | ✓ panel render             | ✓               | —                 |
| P4.2-P4.6 deploy       | smoke         | —                            | smoke against deployed URL | smoke           | health-check curl |
| P5 entrance            | —             | —                            | ✓ landing→demo→booking     | ✓               | —                 |

---

## §4 Audit gate (per `feedback_pre_done_audit`)

Per sub-phase commit:

- [ ] Cross-tenant isolation tests (если touched repo)
- [ ] PK-separation invariant
- [ ] Enum FULL coverage roundtrip
- [ ] null-patch vs undefined-patch semantics
- [ ] updatedAt monotonic
- [ ] UNIQUE collision per index
- [ ] Adversarial-reading 9-item hostile checklist
- [ ] Layer 4 (Playwright) green
- [ ] Layer 5 (axe) green
- [ ] Ratchet check (depcruise / knip / typecheck / biome / weak_assertions = 0)
- [ ] 9-gate pre-commit pass
- [ ] Memory updated (canon / decisions / blockers)

---

## §5 Open questions / decisions to track

- **Domain choice** — `sochi-pms.ru` / `try.<custom>` / TBD. Решить до P4.3.
- **YC organization** — новый billing-account или существующий пользователя ed@? Решить до P4.2.
- **VAT code production** — 22% от 01.01.2026 (code 11/12), но accommodation льгота сохраняется. Empirically verify в первом sandbox-receipt.
- **Demo reset frequency** — nightly OR per-session? Linear-pattern (browser-local) не подходит, выбираем nightly.
- **SMS verified-real opt-in** — отложено в backlog после P5 ship. AWS End User Messaging pattern.

---

## §6 Что НЕ делаем в этом плане (явно out-of-scope)

- Channel Manager live (TravelLine / Островок / Я.Путешествия — NDA sandbox, отложено до первого production-клиента)
- МВД ЕПГУ live (legal block — ст.322.3 УК для demo-tenant, технически невозможно без КЭП отельера)
- Archive Builder КриптоПро live (коммерческая лицензия CSP)
- РКЛ Kontur (insufficient public info)
- Account/Security UI deep modernization (отложено)
- Inventory backlog `.bis` follow-ups
- Каналы / Гости / Профиль / Housekeeping разделы (отложено до post-deploy — каждая фича после deploy сразу попадает к prospects)

---

## §7 Execution order

1. **P1.1** (env + factory binding) — start
2. **P1.2** (yookassa-provider)
3. **P1.3** (webhook handler) ← critical path
4. **P1.4-P1.7** (3DS + tests + empirical + adversarial)
5. **P2.1-P2.5** (Vision) — after P1 ship
6. **P3** (SMS DemoInbox) — параллельно P2
7. **P4** (deploy) — стартует параллельно после P1.1 ship
8. **P5** (entrance) — после P4 deploy live

Каждая phase = atomic commit на main. Push на explicit user signal per session canon.
