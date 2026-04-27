# План v2 «Полностью рабочая локальная система до M8»

**Версия:** 2 (после самоаудита v1 + 4 волн ресерча)
**Дата:** 2026-04-27
**Автор и единственный ответственный:** ed (senior + lead + product)
**Цель:** довести систему до production-grade с полным покрытием 7 функций мандата Алисы и сопутствующего compliance-набора. Единственное что отделяет нас от продакшна — переключение адаптеров с моков на реальные внешние сервисы.

**Источники:** 19 research-файлов в [plans/research/](research/), все 2026-04 и новее.

---

## 0. Контекст и canonical references

### 0.1 Memory canon (must-read перед работой)

- [project_initial_framing.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_initial_framing.md) — мандат Алисы: 7 функций × 3 боли.
- [project_demo_strategy.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_demo_strategy.md) — «всё локально → демо → интеграции».
- [project_payment_domain_canonical.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_payment_domain_canonical.md) — M6 canonical.
- [project_event_architecture.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_event_architecture.md) — CDC + outbox + activity log canon.
- [project_ydb_specifics.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_ydb_specifics.md) — YDB native specifics.
- [feedback_yandex_cloud_only.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_yandex_cloud_only.md) — native стек.
- [feedback_no_halfway.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_no_halfway.md) — без полумер.
- [feedback_strict_tests.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_strict_tests.md) — strict tests.
- [feedback_pre_done_audit.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_pre_done_audit.md) — pre-done audit gate.
- [feedback_research_protocol.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_research_protocol.md) — research только 2026.
- [project_horeca_domain_model.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_horeca_domain_model.md) — domain model.

### 0.2 Research-файлы по доменам

**Внешние интеграции:**
- [epgu-rkl.md](research/epgu-rkl.md) — ЕПГУ Скала + РКЛ
- [yandex-vision-passport.md](research/yandex-vision-passport.md) — OCR (переехал в AI Studio)
- [yookassa-54fz.md](research/yookassa-54fz.md) — payments + 54-ФЗ
- [channel-managers.md](research/channel-managers.md) — TravelLine + Ostrovok + Я.Путешествия
- [smartcaptcha-object-storage.md](research/smartcaptcha-object-storage.md) — anti-bot + storage

**Domain canon:**
- [horeca-kpi-canonical.md](research/horeca-kpi-canonical.md) — USALI 11th Rev
- [public-widget-ux.md](research/public-widget-ux.md) — 3-screen flow
- [hotel-content-amenities-media.md](research/hotel-content-amenities-media.md) — OTA codelists + ПП-1951
- [hotel-addons-extras.md](research/hotel-addons-extras.md) — Apaleo Services pattern
- [cancellation-refund-flows.md](research/cancellation-refund-flows.md) — ПП №1912

**Архитектура:**
- [architecture-patterns.md](research/architecture-patterns.md) — adapter factory + booking lock + outbox
- [ru-compliance-2026.md](research/ru-compliance-2026.md) — полный compliance overview
- [notifications-references.md](research/notifications-references.md) — 7 templates + reference number
- [datalens-frontend-stack.md](research/datalens-frontend-stack.md) — DataLens + frontend

**Свежесть Q1-Q2 2026 + 2027:**
- [wave4-q1q2-2026-freshness.md](research/wave4-q1q2-2026-freshness.md) — критические правки Q1-Q2 2026
- [wave4-pms-vendors-datalens-2026.md](research/wave4-pms-vendors-datalens-2026.md) — Apaleo Copilot + DataLens Public API
- [wave4-payments-april-2026.md](research/wave4-payments-april-2026.md) — YooKassa апрель + Yandex Pay + T-Bank
- [wave4-mcp-yandex-ai.md](research/wave4-mcp-yandex-ai.md) — MCP + YandexGPT + Алиса
- [wave4-2027-anticipated.md](research/wave4-2027-anticipated.md) — 2027 anticipated changes

---

## 1. Главные изменения относительно v1

### 1.1 Структурные изменения

| v1 | v2 |
|---|---|
| 7 подфаз M8.A — M8.G | **8 подфаз M8.0 — M8.G** (добавлен **M8.0 prep + M8.E MCP-сервер**) |
| M8.E (sandbox gate) — после A/B/C/D | **M8.0 prep — перед A/B/C/D** (factory + APP_MODE до того как нужны) |
| MCP в M9 | **MCP в M8.E** (Apaleo + Hospitable релизнули март-апрель 2026) |
| 10-13 недель | **14-18 недель** (добавлен ресерч + новые подфазы) |

### 1.2 Critical правки domain (от ресерча)

| Тема | v1 | v2 |
|---|---|---|
| BAR-NR | rate plan тип | **запрещён в РФ** (ПП №1912) → `BAR-PROMO-1N` (1-night cap) |
| Cancellation cap | произвольный | **1 night cap для B2C** (ПП №1912 с 01.03.2026) |
| Reference number | TypeID | **`<TENANT_SLUG>-<NANOID9>`** Crockford-base32 |
| Notification recipient | user only | **user / guest / system / channel** |
| Booking lock | distributed | **YDB native serializable + OCC** (не Redis) |
| Outbox | per-domain | **polymorphic + schema-discriminated** (canon) |
| Charting | TBD | **Recharts v3 через shadcn Chart** |
| OCR | client-side | **server-side через Yandex Vision** |
| Image pipeline | Cloudinary-like | **Object Storage + Cloud Functions + sharp** |
| Feature flags | Unleash/LaunchDarkly | **env vars + DB-config + Flagd self-host** (Yandex Cloud only) |
| KPI revenue | inclusive cancel/no-show | **USALI 11th Rev: cancel/no-show OUT** |
| Channel inventory | TBD | **pooled + monotonic version** |
| Channel sync | polling-only | **hybrid: push outbound + webhook+polling reconciliation** |
| ЮKassa Чеки | optional | **canonical с 21.04.2026 (yoo_receipt)** |
| СБП recurring | uncertain | **GA 2026 (200+ банков)** |
| Tax rates | hardcoded | **`system_constants` year-versioned** |
| ЕПГУ flow | single-stage | **2-фазный: reserveOrderId → push/chunked → polling** |
| ЕПГУ transport | direct | **interface: GostTLS + SVOKS + Proxy-via-partner** |
| Identity verification | OCR only | **open enum: passport_paper / passport_zagran / driver_license / ebs / digital_id_max** |
| Confidence для OCR | API-based | **наша heuristic** (Vision возвращает 0.0) |

### 1.3 Critical правки compliance (от волны 4)

| Что было | Что должно быть |
|---|---|
| 0% НДС accommodation до 31.12.2030 | **до 30.06.2027** (продление до 2030 — анонс, не закон) |
| НПД лимит 2.4 млн ₽ | **3.8 млн (2026), 4.0 (2027), 4.2 (2028)** |
| ФЗ-93 гостевые дома | **ФЗ-127 от 07.06.2025 + ПП №1345 от 30.08.2025** |
| ПП-1853 действует | **утратило силу с 01.03.2026** |
| Не упомянуто | **ПП-174 от 21.02.2026** — биометрия + загранпаспорт + водительское |
| Не упомянуто | **МАХ цифровой ID** — пилот в Сочи (Sochi Park, Mantera Supreme) |
| Не упомянуто | **Универсальный QR НСПК с 01.09.2026** (закон №248-ФЗ) |
| Не упомянуто | **Цифровой рубль с 01.09.2026** для tenants >120 млн ₽ |
| Не упомянуто | **СБП ИНН в payload с 01.07.2026** |
| Я.Путешествия 17% | **10% (extranet)** (правка) |
| ФФД 1.3 anticipated | **НЕ объявлен** (убрать) |
| СВОКС mandate 2027 | **NON-CONFIRMED** (закладываем interface) |
| ЕБС mandate hospitality | **NON-CONFIRMED** (open enum identity) |
| УСН порог НДС | **60 млн ₽ (376-ФЗ)**, не 20/15/10 (требует WebFetch на 2027) |

---

## 2. Принципы инженерии (обновлено)

### 2.1 Native стек (Yandex Cloud only)

**Обязательные**:
- **Backend**: Hono + YDB + Better Auth (без изменений).
- **Email**: Yandex Postbox (M7.fix.2 wired).
- **Storage**: Yandex Object Storage (S3-compat).
- **Image processing**: Yandex Cloud Functions + sharp/vips (нет managed image-transformation в YC).
- **Captcha**: Yandex SmartCaptcha invisible.
- **OCR**: Yandex Vision (модель `passport`) — переехал в **AI Studio** (`aistudio.yandex.ru/docs/ru/vision/`).
- **AI internal**: YandexGPT 5.1 Pro (admin AI assistant) — 30-60× дешевле OpenAI.
- **AI external**: MCP-сервер (open standard) для Claude / GPT / Yandex.
- **TTS/ASR**: SpeechKit (для voice-booking M9+).
- **Maps**: Yandex Maps JS API v3.
- **Monitoring**: Yandex Monium (no-op exporter сейчас, switch на demo-фазе).
- **CI/CD**: SourceCraft (для deploy фазы).
- **Payments**: YooKassa primary (= ЮMoney НКО = Yandex group), T-Bank Phase 2.
- **Feature flags**: env vars (Phase 1) + DB-config (Phase 2) + Flagd self-host (Phase 3 если нужно).
- **Frontend**: React 19 + Vite 8 + shadcn 4.5 + Recharts v3 + Lucide-react + Lingui v6.

**Запрещены** (нарушают canon):
- AWS S3, AWS SES, Cloudflare Turnstile, GA4, Sentry SaaS, Datadog, Cloudinary, Imgix.
- Unleash, LaunchDarkly (Phase 1: env vars; Phase 3: Flagd self-host).
- OpenAI API direct (только через MCP-server).

### 2.2 Behaviour-faithful моки (без полумер)

См. [research/architecture-patterns.md](research/architecture-patterns.md) §1.

Каждый mock-адаптер обязан воспроизводить:
- **Формат** до уровня поля, типа, обязательности.
- **Коды ошибок** реального API.
- **Тайминги** с jitter.
- **Идемпотентность**.
- **Eventual consistency** (sometimes stale).
- **Подписи / OAuth-токены / ЭЦП** на уровне формата.

**Принцип:** «если завтра подключим реальный API и он сломает наш код — значит мок был неправильный». Перепишем мок, не код.

### 2.3 Adapter factory pattern (TypeScript 2026 canon)

См. [research/architecture-patterns.md](research/architecture-patterns.md) §1.2-1.4.

**Interface + factory function**, НЕ abstract class. Discriminated union `code: 'stub' | 'yookassa' | ...`. НЕ DI-container до 10+ адаптеров.

```ts
domains/{domain}/adapter/
  {Adapter}.ts          // interface
  {Adapter}MockImpl.ts  // behaviour-faithful mock
  {Adapter}HttpImpl.ts  // empty stub, throws "not implemented in M8"
  {Adapter}.factory.ts  // chooses by env flag
  {Adapter}MockImpl.test.ts // тесты на сам мок
```

### 2.4 Resilience policies (Cockatiel)

См. [research/architecture-patterns.md](research/architecture-patterns.md) §1.7.

Для каждой внешней зависимости — все 4:
- Timeout (никогда не ждать вечно).
- Retry с exp backoff + jitter.
- Circuit breaker (после N consecutive fails).
- Bulkhead (лимит concurrent calls per provider).

### 2.5 Sandbox/Production gate

См. M8.0 prep ниже. **Startup assertion** на `NODE_ENV=production` + Mock-adapters → fail-fast.

### 2.6 Empirical research перед каждым моком

Все 19 research-файлов уже созданы. Перед написанием новой интеграции — добавить research-файл в [plans/research/](research/) если ещё не покрыто.

### 2.7 Production-grade с первой строчки

Каждая страница — RBAC × cross-tenant × valid-input × invalid-input × adversarial.
Каждый воркер — ретраи × idempotency × outbox × CDC.
Каждый эндпоинт — zod-валидация × audit-log × rate-limit (на публичных).

### 2.8 Strict tests (расширено)

[feedback_strict_tests.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_strict_tests.md) + новое:
- Тесты должны **проверять поведенческую достоверность мока против реального API documentation**.
- Если документация говорит «возвращает 422 при дубле» — мок обязан возвращать 422 при дубле, и тест это проверяет.

### 2.9 Pre-done audit gate

[feedback_pre_done_audit.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_pre_done_audit.md). Каждая подфаза заканчивается paste-and-fill чек-листом.

### 2.10 No half-measures

[feedback_no_halfway.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_no_halfway.md). Делаем полностью.

---

## 3. Текущий фактический статус (по коду на 2026-04-27)

| # | Функция | Backend | Frontend | End-to-end |
|---|---|---|---|---|
| 1.1 | Госуслуги (Скала-ЕПГУ) | ❌ | ❌ | ❌ |
| 1.2 | AI-сканер паспортов | ❌ | ❌ ручной ввод | ❌ |
| 2.1 | Шахматка | ✅ M3-M4 | ✅ M5 | ✅ |
| 2.2 | Channel Manager | ❌ | ❌ | ❌ |
| 2.3 | Public widget + платежи | 🟡 M6 stub-provider | ❌ | ❌ |
| 3.1 | KPI Dashboard | ❌ | ❌ | ❌ |
| 3.2 | Email/SMS уведомления | ✅ M7.A+B | ✅ M7.fix.3.d | ✅ |
| Бонус | Туристический налог 2% | ✅ M7.A.3 | ✅ M7.fix.3.b | ✅ |

**Итог**: 2 из 7 функций закрыты. 0 из 3 болей закрыты end-to-end.

---

## 4. Зафиксированные решения (Q1-Q12)

### v1 решения (подтверждены)

| # | Вопрос | Решение |
|---|---|---|
| Q1 | KPI dashboard | **A** — KPI-домен + native UI + DataLens-готовность |
| Q2 | Channel Manager | **3 канала сразу** (TravelLine + Я.Путешествия + Ostrovok) |
| Q3 | Public widget | **Роуты в существующем frontend** |
| Q4 | Платежный provider | **Только YooKassa** primary (фабрика готова к T-Bank Phase 2) |
| Q5 | MCP-сервер | **M8.E** (изменено: было M9; релиз Apaleo+Hospitable 2026-Q1 заставляет двигать) |
| Q6 | Сидеры | **Фиксированные команды** `pnpm seed:*` |
| Q7 | Custom Object Engine | **Отложен в M11+** |

### v2 новые решения (от ресерча)

| # | Вопрос | Решение |
|---|---|---|
| Q8 | Booking lock | **YDB native serializable + OCC**, version-based last-write-wins |
| Q9 | Inventory model | **Pooled per-room-type** (industry consensus 2026) |
| Q10 | Channel sync | **Hybrid: push outbound + webhook+polling reconciliation** |
| Q11 | Reference number | **`<TENANT_SLUG>-<NANOID9>`** (Crockford-base32, no vowels/lookalikes) |
| Q12 | Charting | **Recharts v3 через shadcn Chart** |

---

## 5. Roadmap фазы (8 подфаз M8.0 — M8.G)

| Подфаза | Что закрывает | Время |
|---|---|---|
| **M8.0** | **PREP**: adapter factory + APP_MODE gate + system_constants table + EpguTransport interface | 1 неделя |
| **M8.A.0** | **Property content**: media + amenities + descriptions + addons + tenant onboarding (КСР, ФЗ-127) + notification расширение для guests | 2 недели |
| **M8.A** | ЕПГУ адаптер + AI passport + РКЛ + миграционный учёт UI | 3 недели |
| **M8.B** | Public widget + YooKassa + 54-ФЗ + СБП + SmartCaptcha + ICS + Refund flows | 3 недели |
| **M8.C** | Channel Manager × 3 + composed rate plans + reconciliation | 3-4 недели |
| **M8.D** | KPI domain + Recharts UI + DataLens-готовность (Public API provisioning) | 1.5 недели |
| **M8.E** | **NEW**: MCP-сервер v1 (read-only) + admin AI assistant (YandexGPT) | 2 недели |
| **M8.F** | Документация + сидеры + видео-walkthroughs | 1 неделя |
| **M8.G** | Финальный кросс-функциональный аудит готовности к M9 (real integrations) | 0.5-1 неделя |
| **Итого** | **6 функций мандата + 2 закрыты** + sandbox-инфра + MCP differentiator | **17-18.5 недель** |

---

## 6. M8.0 — PREP (новая префаза)

**Цель:** до того как писать первый адаптер — иметь всю инфраструктуру.

### 6.1 Что делаем

1. **Adapter factory pattern** для всех будущих интеграций ([research/architecture-patterns.md](research/architecture-patterns.md) §1.8).
2. **APP_MODE flag** + startup assertion (production refuses на mock-adapters).
3. **`system_constants` table** для year-versioned значений (НДС, НПД-лимит, тур.налог, минимум 100₽/сутки).
4. **EpguTransport interface** (GostTLS / SVOKS / Proxy-via-partner — заложено).
5. **Cockatiel resilience wrapper** для всех HTTP-вызовов.
6. **`feature_flags` table** в DB (env-fallback) — для tenant-level toggles.
7. **OTEL semconv 1.40** на adapter calls (no-op exporter, готов к Monium).

### 6.2 Schema

```
system_constants (
  key text,
  value_year int,
  value_data jsonb,
  effective_from date,
  effective_to date NULL,
  PRIMARY KEY (key, value_year)
)

-- Примеры:
('vat_accommodation_rate', 2026, {"vat_code": 5, "rate": 0.0}, '2026-01-01', '2027-06-30')
('vat_accommodation_rate', 2027, {"vat_code": 5, "rate": 0.0}, '2026-01-01', '2027-06-30')
('vat_general_rate', 2026, {"vat_code": 11, "rate": 22.0}, '2026-01-01', NULL)
('npd_self_employed_limit_rub', 2026, {"limit_kopecks": 380000000}, '2026-01-01', '2026-12-31')
('npd_self_employed_limit_rub', 2027, {"limit_kopecks": 400000000}, '2027-01-01', '2027-12-31')
('tourist_tax_sochi_rate', 2026, {"rate_percent": 2.0, "min_per_night_kop": 10000}, '2026-01-01', '2026-12-31')
('tourist_tax_sochi_rate', 2027, {"rate_percent": 3.0, "min_per_night_kop": 10000}, '2027-01-01', '2027-12-31')
('usn_vat_threshold_rub', 2025, {"threshold_kopecks": 6000000000}, '2025-01-01', NULL)
('hotel_classification_required', 2026, {"required": true, "registry_url": "classification.tourism.gov.ru"}, '2025-09-01', NULL)
```

### 6.3 Pre-done checklist

```
[ ] AdapterFactory base interface создан
[ ] APP_MODE startup assertion (production fails на mock)
[ ] /api/health/adapters endpoint truthful
[ ] system_constants table + 10+ rows seeded
[ ] EpguTransport interface (3 impl stub)
[ ] Cockatiel wrap для PaymentAdapter (refactor existing)
[ ] feature_flags table + middleware
[ ] OTEL semconv added to adapter spans
[ ] pnpm test:serial green
[ ] Memory updated: project_sandbox_gate.md
```

---

## 7. M8.A.0 — Property Content (новая префаза, был забыт в v1)

**Цель:** до Public widget — иметь полные property data (фото + amenities + описания + addons).

См. [research/hotel-content-amenities-media.md](research/hotel-content-amenities-media.md) + [research/hotel-addons-extras.md](research/hotel-addons-extras.md).

### 7.1 Что делаем

1. **Media management** — фото property/rooms через Yandex Object Storage:
   - Upload через pre-signed PUT URLs.
   - Cloud Functions trigger → 6 variants × 2 formats (AVIF + WebP) через sharp.
   - EXIF strip mandatory.
   - 16:9 aspect ratio для room hero.
2. **Amenities domain**:
   - Internal enum codes (`AMN_WIFI_FREE_ROOM`, `AMN_AC`, `AMN_PARKING_INDOOR_FREE`).
   - Mapping table → OTA HAC/RMA/ITT codes (для будущей дистрибуции через CM).
3. **Descriptions** (i18n RU+EN):
   - Markdown body, structured sections (location/services/rooms/dining/family/accessibility/pets).
   - Schema.org JSON-LD `Hotel` auto-emit.
4. **Addons domain** (Apaleo Services pattern):
   - Categories (12 enum: F&B, Transfer, Parking, Wellness, Activities, etc).
   - Pricing units (PER_STAY / PER_PERSON / PER_NIGHT / PER_NIGHT_PER_PERSON / PER_HOUR / PERCENT_OF_ROOM_RATE).
   - Inventory levels: NONE / DAILY_COUNTER (TIME_SLOT отложить в M9).
   - vat_at_service_date snapshot.
5. **Notification расширение для public guests**:
   - `notification_recipients.kind = 'user' | 'guest' | 'system' | 'channel'`.
   - 7 канонических templates RU ([research/notifications-references.md](research/notifications-references.md) §10).
6. **Tenant onboarding** (compliance gates):
   - **Реестр КСР id** обязателен (ПП-1951, штраф 300-450к ₽ без записи).
   - Гостевые дома: ФЗ-127 + ПП №1345 + региональный закон Краснодарского края.
   - Tax regime enum (`OSN`, `USN_DOHODY`, `USN_DOHODY_RASHODY`, `PSN`, `NPD`, `AUSN_DOHODY`, `AUSN_DOHODY_RASHODY`).
   - `annual_revenue_estimate_rub` (для УСН-НДС прогноза).
   - DPA подписание (152-ФЗ ст. 6 ч. 3).
7. **Activity log actorType расширение**: `user | guest | system | channel`.

### 7.2 Schema

См. [research/hotel-content-amenities-media.md](research/hotel-content-amenities-media.md) §§5-8.

Новые миграции:
- `0021_property_content.sql` — descriptions, sections, SEO, Schema.org.
- `0022_media_objects.sql` — original + variants + EXIF-stripped flag.
- `0023_amenities.sql` — internal enum + OTA mapping.
- `0024_addons.sql` — Apaleo Services pattern.
- `0025_tenant_compliance.sql` — KSR registry id, tax regime, DPA, classification.
- `0026_notification_recipient_kind.sql` — extend notification_recipients enum.

### 7.3 Pre-done checklist

```
[ ] Media pipeline (PUT presigned + Cloud Function trigger + variants)
[ ] EXIF strip verified
[ ] Amenities seed (50+ canonical codes)
[ ] Descriptions i18n (RU + EN)
[ ] Schema.org JSON-LD генерируется
[ ] Addons CRUD UI + 12 categories
[ ] Pre-signed URL TTL ≤ 5min для admin audit
[ ] notification_recipients расширен на guest/system/channel
[ ] 7 templates RU (booking_confirmed, payment_receipt, pre_arrival, arrival_day, post_stay_review, booking_cancelled, booking_modified)
[ ] Tenant onboarding wizard: KSR registry id + tax regime + DPA + revenue estimate
[ ] axe-core green
[ ] Cross-tenant × every endpoint
[ ] pnpm test:serial green
[ ] Memory: project_property_content_canonical.md
```

---

## 8. M8.A — ЕПГУ + AI Passport + РКЛ

См. [research/epgu-rkl.md](research/epgu-rkl.md) + [research/yandex-vision-passport.md](research/yandex-vision-passport.md).

### 8.1 Что делаем

**ЕПГУ:**
- 2-фазный submit: `reserveOrderId` → `pushArchive` (multipart) → `orderId`.
- Polling-only (no webhooks): 1 мин первые 10 мин, 5 мин до часа, экспоненциально.
- Lifecycle: статус 17 → 21 → 1 → 2 → 3 (final) или 4 (final).
- 8 категорий ошибок mock (validation_format, signature_invalid, duplicate_notification, document_lost, rkl_match, region_mismatch, stay_period_exceeded, service_temporarily_unavailable).
- Тайминг mock: P95=20мин, P99=60мин.
- 5-10% «lost confirmation» для снятия с учёта.
- ЭЦП ГОСТ Р 34.10-2012 (mock validates только присутствие .sig файлов).
- `EpguTransport` interface (GostTLS impl сейчас, SVOKS позже).

**AI Passport (Yandex Vision, переехал в AI Studio):**
- Endpoint: `https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText` (тот же).
- Format: JSON + base64 (НЕ multipart).
- Confidence quirk: API возвращает `0.0` часто → **наша heuristic** (regex на серию/номер, sanity на дату, age check).
- 9 entities: surname, name, middle_name, gender, citizenship, birth_date, birth_place, number, issue_date.
- 20 стран passport model.
- HEIC handling: heic2any client + sharp/libheif server fallback.
- Object Storage TTL: 180 days lifecycle + workflow worker удаляет через 24h после ЕПГУ confirmed.

**РКЛ:**
- Mock через Контур.ФМС API схему (CSV-snapshot).
- 99% clean / 0.5% match / 0.5% inconclusive.
- Latency 50-300 мс.

**ПП-174 (с 01.03.2026):** identity_verification enum: `passport_paper | passport_zagran | driver_license | ebs | digital_id_max`.

### 8.2 Schema

См. [research/epgu-rkl.md](research/epgu-rkl.md) §8 + [research/yandex-vision-passport.md](research/yandex-vision-passport.md) §8.

Новые миграции:
- `0027_guest_documents.sql` — guest_document table с identity_method enum.
- `0028_migration_registration.sql` — ЕПГУ submission + status + attempts + outbox.
- `0029_rkl_history.sql` — RKL check history per guest+document.
- `0030_passport_ocr_audit.sql` — OCR call audit (90 days retention).

### 8.3 Pre-done checklist

```
[ ] EpguTransport interface (3 impl stubs: GostTls, Svoks, Proxy)
[ ] EpguMockImpl: 2-фазный submit, async polling, 8 error categories, durability в YDB-table (не in-memory)
[ ] Async confirmation cron 1м/5м/exp
[ ] CDC outbox + retry policy
[ ] PП-174 identity_methods (5 values)
[ ] Vision endpoint = AI Studio URL
[ ] Vision base64 input validation
[ ] Heuristic confidence (regex + sanity + age check)
[ ] HEIC handling (heic2any + sharp fallback)
[ ] RKL mock с 99/0.5/0.5
[ ] Object Storage TTL для photos
[ ] 152-ФЗ согласие отдельным документом (модалка + хранение)
[ ] axe-core green
[ ] Cross-tenant × все endpoints
[ ] RBAC × все методы
[ ] pnpm test:serial green
[ ] Memory: project_migration_registration_done.md, project_ai_passport_done.md
```

---

## 9. M8.B — Public widget + Payments + 54-ФЗ + СБП

См. [research/yookassa-54fz.md](research/yookassa-54fz.md) + [research/public-widget-ux.md](research/public-widget-ux.md) + [research/cancellation-refund-flows.md](research/cancellation-refund-flows.md) + [research/wave4-payments-april-2026.md](research/wave4-payments-april-2026.md).

### 9.1 Что делаем

**Widget (3-screen flow):**
- Screen 1: Search & Pick (даты + гости + tariff selection inline) с sticky summary.
- Screen 2: Extras (addons accordion).
- Screen 3: Guest details + Embedded Payment (без redirect).
- Screen 4: Confirmation (booking ref + ICS + magic-link + Yandex Maps).

**Payment (YooKassa primary):**
- API v3 base, Idempotence-Key (≤64 chars), 24h scope.
- 3DS via redirect (canon 2026).
- Two-stage capture (`capture: false`).
- 8 webhook events (нет HMAC — IP allowlist + status verification GET /v3/payments/{id}).
- НДС 22% с 01.01.2026, vat_code 11/12.
- Accommodation льгота 0% (vat_code 5) до 30.06.2027.
- ЮKassa Чеки (`yoo_receipt`) since 21.04.2026 — single integration.
- Per-line vat_code (не receipt-уровень literal).
- Settlement T+1.

**СБП (через YooKassa):**
- `payment_method_data.type: sbp`, capture: true обязательно.
- Recurring 2026 GA — 200+ банков.
- ИНН в payload с 01.07.2026 (schema-impact).

**Универсальный QR НСПК с 01.09.2026** (закон №248-ФЗ) — verify YooKassa support.

**Captcha:**
- Yandex SmartCaptcha invisible, npm `@yandex/smart-captcha@2.9.1`.
- Token TTL 5 минут, single-use.
- Backend verify: non-200 → treat as ok (UX rescue).

**Refund flows (4 источника):**
- Admin operator (full control + waiver).
- Public guest (self-service via magic-link).
- Channel pull (Booking VCC / Я.Travel / Ostrovok).
- No-show (cron T+1 day, 1-night cap per ПП №1912).
- Walked guest (overbooking — обязательная relocation per ПП №1912).

**Cancellation policies (canonical):**
- BAR-FLEX, BAR-MOD, BAR-STR, **BAR-PROMO-1N** (заменяет BAR-NR), PAY-ON-ARRIVAL, PAY-NOW, GROUP, CORPORATE, EVENT-PEAK.
- 1-night cap для B2C per ПП №1912.

**Reference number:**
- Format: `<TENANT_SLUG>-<NANOID9>` (Crockford-base32 без vowels/lookalikes).
- Magic-link с signed JWT (TTL 30d view, 15min mutation).
- Brute-force protection: rate-limit + captcha + send-new-link-on-find.

### 9.2 Schema

См. [research/cancellation-refund-flows.md](research/cancellation-refund-flows.md) §15.

Новые миграции:
- `0031_public_booking_intent.sql` — pre-confirm intent с TTL 15 min.
- `0032_rate_plan_cancellation.sql` — discriminated union policy (BAR-NR заменён на BAR-PROMO-1N).
- `0033_walked_guest.sql` — booking status `walked` + relocation_booking_id.
- `0034_payment_method_data_v2.sql` — payment_method.type включая `yandex_pay`, ИНН field для СБП.
- `0035_reference_number.sql` — tenant_public_slug + booking.reference UNIQUE per tenant.

### 9.3 Pre-done checklist

```
[ ] 3-screen widget flow + sticky summary
[ ] Embedded YooKassa payment (без redirect)
[ ] СБП с recurring saving (2026 GA)
[ ] Universal QR support через YooKassa
[ ] ЮKassa Чеки fiscalization (yoo_receipt)
[ ] Per-line vat_code (5/6/11/12)
[ ] BAR-PROMO-1N (вместо BAR-NR) per ПП №1912
[ ] 1-night cap для B2C cancellation
[ ] Walked guest flow (relocation booking)
[ ] 4 cancellation flow sources
[ ] Magic-link с signed JWT
[ ] Reference: TENANT-NANOID9
[ ] Yandex SmartCaptcha invisible на booking submit
[ ] axe-core green на всех widget screens
[ ] Mobile-first verified (360px Galaxy A baseline)
[ ] Cross-tenant × public endpoints
[ ] Adversarial: overbooking race, webhook replay, HMAC absence handling
[ ] 152-ФЗ unchecked consent
[ ] ICS attachment RFC 5545
[ ] Yandex Maps embed
[ ] 7 notification templates trigger correctly
[ ] pnpm test:serial green
[ ] Memory: project_public_widget_done.md, project_yookassa_done.md
```

---

## 10. M8.C — Channel Manager × 3

См. [research/channel-managers.md](research/channel-managers.md).

### 10.1 Что делаем

**Pooled inventory (consensus 2026):**
- `room_type_availability(org_id, room_type_id, date, total_qty, booked_qty, version)`.
- Monotonic version per (room_type, date).
- YDB native serializable + OCC (НЕ Redis Redlock).

**Hybrid sync model:**
- Outbound (we → channel): push (CDC-outbox → dispatcher → channel adapter).
- Inbound (channel → us): webhook primary + polling reconciliation (каждый час full pull последних 24h).

**3 channel mocks** (all behaviour-faithful):

**TravelLineMockImpl** (high confidence 8/10):
- OAuth2 token TTL 15 min, JWT.
- 5 API products: Content, Search, Read Reservation, PMS Universal, Reviews.
- Hash-checksum валидация на book.
- CreateBookingToken 24h TTL.
- Rate-limit 3/s, 15/min, 300/h + 429 retry-after.

**OstrovokMockImpl (ETG distribution)** (medium-high 7/10):
- ⚠️ **Distribution API**, не supplier — mock = distribution flow.
- search → hotelpage → prebook → book pipeline.
- prebook required (без него book → 422).
- 8% — `price_changed` between search и prebook.
- Webhook subscription для booking status.

**YandexTravelMockImpl** (medium-low 5/10):
- ⚠️ **Supplier API closed (NDA)** — реверс из Bnovo/Контур.Отель wiki.
- 20+8 beds limit на категорию.
- Mandatory cancellation policy.
- Apartments capped at 1 + no meal plans.
- **Commission 10%** (правка: было 17%).
- Idempotency-Key UUID v4.

**Composed rate plans для каналов** (80% не поддерживают addons как first-class):
- Cartesian product до threshold N=8.
- BAR / BAR+breakfast / BAR+breakfast+parking / BAR+halfboard.

**Conflict resolution** (если overbooking):
- Apaleo/Mews-style: возможен, gate UI-уровня.
- `OverbookingDetected` event → admin alert + flag в Шахматке.
- Walk-policy от operator decision.

### 10.2 Pre-done checklist

```
[ ] PooledInventory с monotonic version
[ ] YDB serializable transaction для booking lock
[ ] CDC-outbox → channel-dispatcher
[ ] 3 mock adapters с realistic behaviour
[ ] Composed rate plans для каналов (max 8)
[ ] Я.Путешествия 10% commission (НЕ 17%)
[ ] Overbooking detection + admin alert
[ ] Walked guest relocation flow integration
[ ] Reconciliation cron 1h
[ ] cross-tenant + RBAC
[ ] pnpm test:serial green
[ ] Memory: project_channel_manager_done.md
```

---

## 11. M8.D — KPI Domain + DataLens-готовность

См. [research/horeca-kpi-canonical.md](research/horeca-kpi-canonical.md) + [research/datalens-frontend-stack.md](research/datalens-frontend-stack.md) + [research/wave4-pms-vendors-datalens-2026.md](research/wave4-pms-vendors-datalens-2026.md).

### 11.1 Что делаем

**KPI domain (USALI 11th Rev canon):**
- **Room Revenue** (для ADR/RevPAR) = `accommodation_charges` − VAT − tourist_tax − cancellation_fees − no_show_fees − addons. Resort fee mandatory IN.
- **Available Rooms** = active inventory − OOO − OOS (operational), toggle на STR-mode.
- **ADR** = null при Sold = 0; **RevPAR** = 0 при Revenue = 0.
- **Aggregate period** = `sum(num) / sum(denom)`, не `avg(daily)`.
- **GOPPAR** — monthly only.
- **Per-property + per-room-type** breakdowns primary.

**Schema:**
- `kpi_occupancy_daily` (occupancyOperationalPercent + occupancyStrPercent + paidOccupancyPercent).
- `kpi_revenue_daily` (room/cancel_fee/noShow_fee/F&B/addon, ADR, RevPAR, TRevPAR — все micros).
- `kpi_pace_snapshot` (booking pace 0-7d/8-30d/31-90d/91+).

**Frontend (Recharts v3 через shadcn Chart):**
- 3 graphs: Occupancy line, ADR bar, RevPAR line.
- Range picker, property filter.
- KPI cards с YoY comparison (day-of-week aligned).
- Export CSV/XLSX (write-excel-file).

**DataLens-готовность (Phase 2):**
- DataLens Public API (запущен январь 2026) — `https://api.datalens.tech` с IAM-tokens.
- DataLens v2.8.0 OSS — YDB connector + VIEW support.
- YDB VIEW для dataset (cross-tenant с org_id column).
- Multi-tenant pattern: один shared workbook + RLS через signed JWT с `org_id`.
- Embedded private (JWT PS256) — empirical verify через `git clone datalens-tech/datalens-examples`.

### 11.2 Pre-done checklist

```
[ ] Materialized rollup tables (kpi_occupancy_daily, kpi_revenue_daily, kpi_pace_snapshot)
[ ] CDC-driven worker для refresh (hourly + daily reconciliation)
[ ] USALI 11 canon (cancel/no-show fees OUT of Room Revenue)
[ ] Operational + STR + Paid Occupancy modes
[ ] Recharts v3 + shadcn Chart 3 graphs
[ ] axe-core a11y на charts
[ ] YoY comparison day-of-week aligned
[ ] YDB VIEW для DataLens (cross-tenant with org_id)
[ ] DataLens Public API provisioning helper (Phase 2 prep)
[ ] cross-tenant + RBAC
[ ] pnpm test:serial green
[ ] Memory: project_kpi_dashboard_done.md
```

---

## 12. M8.E — MCP Server v1 + Admin AI Assistant (NEW)

См. [research/wave4-mcp-yandex-ai.md](research/wave4-mcp-yandex-ai.md).

### 12.1 Контекст

Apaleo Copilot 26.03.2026 + Hospitable MCP 03.04.2026 + Aven Q2 2026 — **«2026 = year of MCP»**. MCP-сервер v1 read-only поверх существующего Hono RPC = **3-5 дней**, **самый дешёвый differentiator**.

### 12.2 M8.E.1 — MCP Server v1 (read-only)

- `@modelcontextprotocol/sdk@1.29.x` + `@hono/mcp` поверх Hono backend.
- Endpoint: `/api/v1/mcp` (single, multi-tenant через token).
- Streamable HTTP transport, stateless.

**Auth:**
- OAuth 2.1 PKCE через Better Auth.
- Discovery: `GET /.well-known/oauth-protected-resource`.
- Resource Indicator: `https://api.<our-domain>/api/v1/mcp`.

**Tools (10 read-only):**
- `bookings.list`, `bookings.get`
- `rooms.list`, `roomTypes.list`, `ratePlans.list`
- `availability.check` (voice-booking ready)
- `guests.search` (с маскированием ПД)
- `folios.list`, `payments.list`
- `kpi.summary`

**Resources:**
- `property://current` (JSON org-spec)
- `room-types://list`
- `housekeeping-sop://standard` (text/markdown)

**Prompts:**
- `morning-briefing`, `weekend-occupancy-forecast`, `late-checkout-template`

**Tracing:** OTEL spans `mcp.tool.name / mcp.tenant.id / mcp.duration_ms` + activity-log row.

### 12.3 M8.E.2 — Admin AI Assistant (YandexGPT)

- Sheet/sidebar в admin-UI.
- YandexGPT 5.1 Pro через AI Studio Assistants API (0.40-0.80 ₽/1k tokens).
- Function-calling → MCP-client → наш MCP-сервер.
- 5-10 системных промптов для PMS-задач:
  - «Покажи arrivals на сегодня»
  - «Какая занятость на выходные»
  - «Подготовь сообщение гостю с late checkout 15:00»
- Streaming responses в UI.
- Conversation state в YDB (тред per user×org).

### 12.4 M8.E.3 — Public MCP demo + docs

- Публичная страничка с инструкциями подключения Claude Desktop / ChatGPT Apps.
- 1 видео walkthrough.
- Demo-org с anonymized data.

### 12.5 Pre-done checklist

```
[ ] MCP server v1 (10 read-only tools)
[ ] Better Auth OAuth 2.1 PKCE bridge
[ ] Resource Indicator pinning
[ ] Cross-tenant × every tool unit-test
[ ] Mask-PII assertions
[ ] OTEL tracing per call
[ ] E2E test с Claude Desktop + MCP Inspector
[ ] Yandex AI Studio Assistant работает с MCP-client → наш сервер
[ ] Admin UI assistant sheet/sidebar
[ ] 5-10 system prompts
[ ] Streaming responses
[ ] Public docs + 1 walkthrough video
[ ] pnpm test:serial green
[ ] Memory: project_mcp_server_v1_done.md
```

---

## 13. M8.F — Документация + Сидеры + Видео

### 13.1 Что делаем

- **Adapter contracts docs** — `docs/integrations/{name}.md` для каждой интеграции.
- **Сидеры** — `pnpm seed:tenant`, `pnpm seed:bookings`, `pnpm seed:channels`, `pnpm seed:payments`, `pnpm seed:all`.
- **Видео-walkthroughs** через `scripts/walkthrough/`:
  - 01-internal-booking
  - 02-foreign-booking + МВД scan
  - 03-public-widget
  - 04-channel-manager + reconciliation
  - 05-analytics
  - 06-tax-report (update)
  - 07-notifications (update)
  - 08-mcp-demo
  - 09-admin-ai-assistant
- **README** обновление + per-page help-блоки.

---

## 14. M8.G — Финальный аудит готовности к M9

### 14.1 Сквозные проверки

```
СКВОЗНЫЕ ПРОВЕРКИ
[ ] Cross-tenant probe: каждый endpoint × каждый tenant × adversarial
[ ] RBAC matrix: каждый endpoint × каждой роли × каждый action
[ ] Enum coverage: каждый enum проверен на все значения
[ ] Null vs undefined: patches ведут себя различно
[ ] UNIQUE collisions: каждый unique index проверен
[ ] CDC + outbox: каждый событийный triggers корректно
[ ] Activity log: каждый state-change отражён
[ ] Idempotency: каждый «опасный» endpoint проверен повторами
[ ] Rate-limit: каждый публичный endpoint защищён
[ ] Captcha: каждая публичная мутация защищена

СРАВНЕНИЕ С РЕАЛЬНОСТЬЮ (behaviour-faithful)
[ ] EpguMockImpl сверен с research/epgu-rkl.md
[ ] VisionMockImpl сверен (confidence: 0 quirk imitated)
[ ] RklMockImpl сверен
[ ] YooKassaMockImpl сверен (4 webhook events, 18 cancellation reasons)
[ ] FiscalMockImpl сверен
[ ] CaptchaMockImpl сверен (treat non-200 as ok)
[ ] TravelLineMockImpl сверен (8/10 confidence)
[ ] OstrovokMockImpl сверен (distribution API)
[ ] YandexTravelMockImpl сверен (10% commission)

ИНФРАСТРУКТУРНЫЕ
[ ] APP_MODE=production → отказывает при mock
[ ] APP_MODE=sandbox → всё работает
[ ] /api/health/adapters truthful
[ ] SANDBOX banner виден
[ ] Tracing работает
[ ] Все cron'ы работают без дубликатов

ТЕСТЫ
[ ] pnpm test:serial: 100% green
[ ] pnpm test (parallel): 100% green
[ ] pnpm coverage: floor не упал
[ ] pnpm mutate (на pure libs): floor не упал
[ ] pnpm build: green
[ ] pnpm typecheck: green
[ ] pnpm knip: clean
[ ] pnpm sherif: clean
[ ] pnpm depcruise: clean
[ ] pnpm biome: clean
[ ] pnpm e2e:smoke: 100% green с axe a11y gate

DOMAIN-ЦЕЛОСТНОСТЬ
[ ] Все 6 функций мандата (1.1, 1.2, 2.1, 2.2, 2.3, 3.2) + 3.1 Variant A закрыты
[ ] Туристический налог 2% закрыт (бонус)
[ ] Все 3 боли мандата закрыты в локальной системе
[ ] MCP-сервер v1 + admin AI assistant differentiator готовы

DEPENDENCY FRESHNESS (final)
[ ] npm-registry аудит на latest stable
[ ] Memory project_locked_versions.md обновлён

COMPLIANCE
[ ] 152-ФЗ согласие отдельным документом (с 1.09.2025) — verified
[ ] 152-ФЗ breach reporting 24h runbook
[ ] 54-ФЗ vat_code 5/6/11/12 + ЮKassa Чеки
[ ] Тур.налог 2% Сочи + декларация КНД 1153008 2026
[ ] ПП-1912 1-night cap, mandatory disclosure
[ ] ПП-1951 КСР-id обязателен
[ ] ПП-174 identity_methods (5 values)
[ ] DPA с tenant в onboarding
```

---

## 15. Сквозные принципы и инфраструктура

### 15.1 Test partitioning

К существующим test:serial / test / test:unit добавляем:
- `test:integrations` — только integration-тесты.
- `test:e2e` — только playwright.
- `test:adversarial` — only теги adversarial.
- В pre-push gate — оставляем `test:serial`.

### 15.2 Feature flags

В `apps/backend/src/config.ts` per integration:
- `FEATURE_EPGU_ENABLED`, `FEATURE_PASSPORT_OCR_ENABLED`, `FEATURE_RKL_ENABLED`, `FEATURE_PUBLIC_WIDGET_ENABLED`, `FEATURE_CHANNEL_MANAGER_ENABLED`, `FEATURE_KPI_ENABLED`, `FEATURE_MCP_SERVER_ENABLED`.
- DB-level overrides через `feature_flags` table per tenant.
- **НЕ Unleash/LaunchDarkly** — env vars + DB. Phase 3 — Flagd self-host.

### 15.3 Migration policy

- Каждая подфаза — свой набор миграций.
- Backfill scripts — отдельные файлы, идемпотентны, тестируются.
- Additive only (rollback не требуется per YDB).

### 15.4 Activity log canon

Расширения в `packages/shared/src/activity.ts`:
- `objectType`: `migration_registration | passport_scan | rkl_check | public_booking | channel_config | channel_booking | kpi_rollup | mcp_call | walked_guest`.
- `actorType`: `user | guest | system | channel`.
- `activityType`: extensive (см. research-files).

### 15.5 Безопасность

- 152-ФЗ: согласие отдельным документом, retention policy, шифрование at rest.
- 54-ФЗ: фискализация всех успешных платежей.
- Public widget: rate-limit + captcha + HMAC absence handling + zod validation.
- Breach 24h reporting.
- Object Storage SSE-KMS для PII.

### 15.6 A11y (axe-core 4.11.3)

axe-core gate на ВСЕХ новых страницах.

### 15.7 i18n

RU primary, EN secondary (Сочи specifics). Lingui v6.

### 15.8 OTEL semconv 1.40

`messaging.system / messaging.operation.type / messaging.message.id` + custom `outbox.*` attributes.

---

## 16. Risks (обновлённый)

| Риск | Вероятность | Воздействие | Mitigation |
|---|---|---|---|
| Мок недостаточно реалистичен | Средняя | Высокое | Behaviour-faithful canon. Sверка на M8.G. |
| Sandbox → production случайно | Низкая | Критично | APP_MODE startup assertion + CI lint + telemetry. |
| Channel Manager M8.C растягивается | Высокая | Высокое | Жёсткий cap 4 недели. Если не успеваем — урезать до 1 канала (TravelLine). |
| Public widget overbooking race | Средняя | Высокое | YDB serializable + monotonic version. Adversarial тесты. |
| 152-ФЗ нарушения | Низкая | Критично | TTL Object Storage + retention + согласие + DPA + breach 24h runbook. До 15 млн ₽ штраф. |
| Mock OCR false positives | Низкая | Среднее | Heuristic confidence + manual confirmation step. |
| Время до выручки растягивается | Высокая | Высокое (бизнес) | Открытое обсуждение с пользователем. Plan корректируется. |
| Зависимости устаревают | Высокая | Среднее | npm-registry аудит после каждой подфазы. |
| Pre-push gate деградирует | Средняя | Среднее | Test partitioning. Если test:serial > 5 min — split. |
| **NEW:** ЕПГУ-договор регистрация | Высокая (срок) | Высокое | Mock работает full feature, реальная интеграция — отдельная фаза с lead-time 2-6 недель на ОВМ соглашение. |
| **NEW:** Apaleo competition pressure | Высокая | Высокое | MCP в M8.E — обязательно. RU-specifics differentiator. |
| **NEW:** Cost: ЭЦП ~3-5к/год + Yandex Vision биллинг + YooKassa комиссия + договоры с CM | Средняя | Среднее | Закладываем в business plan, не в M8 архитектуру. |
| **NEW:** USN VAT threshold уточнение | Средняя | Среднее | system_constants table + WebFetch верификация перед launch. |
| **NEW:** Универсальный QR с 01.09.2026 | Средняя | Высокое | Verify YooKassa support до июля 2026. |
| **NEW:** СБП ИНН с 01.07.2026 | Средняя | Среднее | Schema готов (ИНН поля not nullable). |

---

## 17. Что НЕ входит (отложено в M9+)

- **Реальные внешние интеграции** — M9.
- **Voice-booking через SpeechKit + Realtime API** — M9.B.
- **Алиса skill для номеров** — M10+.
- **Write-операции через MCP** — M9.A (audit-flow).
- **A2A** (agent-to-agent) — после Apaleo выпустит spec.
- **DCR** (Dynamic Client Registration) — when partner integrators возникнут.
- **Деплой**: SourceCraft, Terraform, Yandex Cloud setup — M9+.
- **PWA / offline support** — M9+.
- **Yandex Monium активация** — M9+ (no-op exporter готов).
- **DataLens setup** (Phase 2) — после deploy.
- **Custom Object Engine** — M11+.
- **Booking.com / Expedia / Airbnb** — phase 2-3.
- **F&B, SPA, ski-school** — после первого pivot.
- **ЕБС** mandate — добавим если объявят.
- **МАХ цифровой ID** — M11+ (пилот в Сочи).
- **Цифровой рубль** — для tenants > 120 млн ₽ Phase 3.
- **Универсальный QR-код НСПК** — verify YooKassa автоматически.
- **NPD / самозанятые** через Robokassa SMZ — Phase 2.
- **T-Bank Acquiring** secondary — Phase 2-3.
- **Yandex Pay** — payment method внутри YooKassa (built-in).

---

## 18. Открытые вопросы (требуют WebFetch перед M-фазами)

1. **376-ФЗ 2027 пороги УСН-НДС** — pravo.gov.ru.
2. **СВОКС mandate hospitality 2027** — digital.gov.ru.
3. **ФФД 1.3 draft** — regulation.gov.ru.
4. **«Поставщик 2.0»** Минцифры — digital.gov.ru.
5. **Сочи турналог 2027 ставка** — sochi.ru осенью 2026.
6. **ПП-1912 поправки** после 01.03.2026.
7. **Yandex Monium GA + pricing** — yandex.cloud/services/monium.
8. **SourceCraft pricing 2026** — yandex.cloud/services/sourcecraft.
9. **DataLens pricing рубли** — yandex.cloud/docs/datalens/pricing.
10. **DataLens private embed JWT schema** — `git clone datalens-tech/datalens-examples`.
11. **YooKassa СМЗ-onboarding 2026** — YooKassa support.
12. **T-Bank webhook signature** — empirical curl-test.
13. **Я.Путешествия комиссия 10% vs 17%** — verify with sales.
14. **Реестр гостевых домов 2027** — Краснодарский край региональный закон.
15. **ЕПГУ соглашение с ОВМ МВД** — региональная процедура Сочи.

---

## 19. Time estimate

С учётом ресерча уже выполненного (4 волны, 19 файлов) — оставшиеся фазы:

| Подфаза | Чистая работа | + ресерч | + интеграция | + тесты + audit | Итого |
|---|---|---|---|---|---|
| M8.0 | 3-4 дня | 0 (готов) | 0 | 1 день | **5 дней** |
| M8.A.0 | 8-10 дней | 0 (готов) | 0 | 2-3 дня | **2 недели** |
| M8.A | 12-15 дней | 0 (готов) | mock | 3-4 дня | **3 недели** |
| M8.B | 12-15 дней | 0 (готов) | mock + reference + magic-link | 3-4 дня | **3 недели** |
| M8.C | 15-18 дней | 0 (готов) | 3 mocks | 3-4 дня | **3-4 недели** |
| M8.D | 6-8 дней | 0 (готов) | DataLens prep | 1-2 дня | **1.5-2 недели** |
| M8.E | 8-10 дней | 0 (готов) | MCP + AI assistant | 2 дня | **2 недели** |
| M8.F | 4-5 дней | 0 | docs + видео | 1 день | **1 неделя** |
| M8.G | 2-3 дня | 0 | audit | 1-2 дня | **0.5-1 неделя** |
| **Итого** | | | | | **17-18.5 недель** |

Если требуется компрессия:
- Срезать M8.C до 1 канала (TravelLine) — экономия 2 недели → **15-16 недель**.
- Срезать M8.E.2 (admin AI assistant) → экономия 1 неделя → **14-15 недель**.

---

## 20. Что я обязан помнить на всех этапах

- **Я единственный ответственный.** Senior + lead + product.
- **Только апрель 2026+ источники** — по жёсткому требованию пользователя.
- **Yandex Cloud only** — никаких non-RU SaaS feature flags / monitoring / image-processing.
- **Без полумер** — делаю полностью.
- **Behaviour-faithful моки** — не «всегда успех».
- **Empirical method** — не верить памяти модели.
- **Strict tests** — exact-value asserts, adversarial paths.
- **Pre-done audit gate** — каждая подфаза.
- **Не торопиться** — при сомнениях спрашиваю.
- При появлении новых learnings — обновлять memory.

---

## 21. Что делаем прямо сейчас

1. Пользователь читает план v2.
2. Подтверждает или корректирует.
3. После утверждения — стартую с **M8.0 prep** (adapter factory + APP_MODE + system_constants + EpguTransport interface).
4. Параллельно — обновление memory согласно правкам:
   - 0% НДС accommodation до **30.06.2027**.
   - НПД лимит **3.8 млн ₽ (2026)**.
   - Гостевые дома: **ФЗ-127 + ПП №1345**.
   - Я.Путешествия комиссия **10%**.
   - **ПП-174** (биометрия + загранпаспорт + водительское).
   - **МАХ цифровой ID** в Сочи (Sochi Park, Mantera Supreme).
   - **Универсальный QR НСПК с 01.09.2026**.
   - **Цифровой рубль с 01.09.2026** для >120 млн ₽.
   - **СБП ИНН с 01.07.2026**.
   - **CloudPayments = T-Bank Group 95%**.
   - **YooMoney не делает выплаты СМЗ с 29.12.2025**.
   - **MCP-сервер в M8.E** (не M9).
   - **Vision переехал в AI Studio**.
   - **Apaleo Copilot 26.03.2026** + **Hospitable MCP 03.04.2026** — competition pressure.

После твоего утверждения — поехали с M8.0.
