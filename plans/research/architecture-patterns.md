# Research: Adapter Factory + Booking Lock + Outbox Patterns 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 3
**Confidence:** High (общие паттерны), Medium (Apaleo/Mews internal specifics)

---

## 0. Главные находки

1. **Apaleo/Mews — НЕ plugin-loader.** Каждая интеграция = отдельный bounded context (~250+ для Apaleo). НЕ строим DI-container до 10+ адаптеров.
2. **TypeScript 2026 canon**: interface + factory function, НЕ abstract class.
3. **3 уровня config**: env (boot), DB (tenant), OpenFeature (operational toggle).
4. **Cockatiel** — winner для resilience policies (circuit breaker + retry + timeout + bulkhead, composable).
5. **YDB native serializable + OCC** — для booking lock. **НЕ** Redis Redlock.
6. **Apaleo/Mews/Booking.com — overbooking возможен** by design, gate UI-уровня. Pooled inventory + version-based last-write-wins.
7. **Polymorphic outbox + schema-discriminated payload** (hybrid) — наш текущий canon корректный для small-medium SaaS.

---

## 1. Adapter Factory + Sandbox/Production gate

### 1.1 Industry pattern (Apaleo, Mews, Stripe, AWS SDK)

- **Apaleo** построен на MACH-архитектуре (Microservices, API-first, Cloud-native, Headless) с экосистемой 250+ интеграций. **НЕ plugin-loader**, а отдельные bounded contexts.
- **Mews** аналогично API-first с отдельным "Marketplace" gateway.
- **Stripe**: один SDK, две режима через ключ — `sk_test_*` vs `sk_live_*`. SDK сам определяет mode по prefix, **не env-flag**. Устраняет класс багов "забыл переключить флаг".
- **AWS SDK**: не имеет "test mode" вообще, только разные endpoints/credentials profiles.

**Lesson для нас:** не пытайтесь строить plugin-loader. `domains/<provider>/*.adapter.ts` достаточно до 10+ провайдеров.

### 1.2 Class vs interface (2026 canon)

В TypeScript-native стеке **2026 best-practice — interface + factory function**, не abstract class:

- ESM tree-shaking лучше с functions.
- Discriminated union (`code: 'stub' | 'yookassa' | 'tkassa'`) даёт exhaustive type-narrow.
- Test setup в 5 строк (нет prototype chain, нет DI container).

DI-контейнеры (`tsyringe`, `inversify`) уместны для крупных систем (10+ сервисов с одинаковой shape). **У вас сейчас 1 (payment), будет ~6.** Не вводите DI-container — добавьте `lib/adapters/registry.ts` с явным dispatch по `code`.

**Ваш existing код** `factory.ts` + `createStubPaymentProvider({ delayMs, now })` — уже идиоматично 2026.

### 1.3 Configuration: 3 уровня

| Уровень | Источник | Пример | Refresh |
|---------|----------|--------|---------|
| **Boot-time** | env vars | `POSTBOX_ENDPOINT`, `YDB_ENDPOINT` | restart |
| **Tenant config** | DB row | `organization.payment_provider_code = 'yookassa'` | per-request |
| **Operational toggle** | OpenFeature/Flagd | `feature.epgu.enabled` | seconds (poll/SSE) |

**OpenFeature как vendor-agnostic стандарт 2026**: пишете против `OpenFeature.getClient()`, провайдером может быть JSON-файл (Flagd) в dev, Unleash в staging, LaunchDarkly в prod — без изменения кода.

**Для вашего кейса** "YooKassa в `mock` mode даже в `staging`":

- НЕ используйте `NODE_ENV` для adapter selection. Анти-паттерн.
- Вводите явный per-adapter toggle: `PAYMENT_PROVIDER=stub|yookassa`, `EPGU_PROVIDER=stub|real`, `CAPTCHA_PROVIDER=stub|smartcaptcha`.
- Tenant override (если нужен) — поле `organization.<adapter>_mode`.

### 1.4 Защита от случайного uplift mock в production

**Три gate'а**:

```ts
// env.ts — startup assertion
if (env.NODE_ENV === 'production') {
  const forbidden = ['PAYMENT_PROVIDER=stub', 'CAPTCHA_PROVIDER=stub']
  for (const f of forbidden) {
    const [k, v] = f.split('=')
    if (env[k] === v) throw new Error(`refusing to start: ${f} in production`)
  }
}
```

1. **Startup assertion**: при `NODE_ENV=production` fail-fast если *_PROVIDER=stub.
2. **CI lint**: pre-merge check, что `production.env.example` не содержит `=stub`.
3. **Runtime telemetry**: каждый adapter эмитит `adapter.mode={stub|sandbox|live}` в первый span. Алерт в Monium когда `provider=epgu, mode=stub, tenant.is_production=true`.

### 1.5 Тестирование

- **Pact contract testing** — overhead для нашего кейса (один backend, один adapter per provider).
- **VCR-style record/replay** — better. Записать реальный YooKassa sandbox response в `__cassettes__/yookassa-initiate-success.json`, replay в CI.
- TS 2026: `nock` + `nock.recorder` или `msw` с `restoreHandlers`.

### 1.6 Anti-corruption layer (DDD)

Ваш `PaymentProvider` интерфейс + `PaymentProviderSnapshot` — **уже** ACL. Канонический pattern:

- **Adapter** — HTTP/SDK/auth.
- **Translator** — provider DTO → domain entity.
- **Facade** — упрощённый интерфейс для service.

Применимость для ЕПГУ/YooKassa/channel managers — **обязательна**. ЕПГУ XML-схема меняется по приказам МВД, не должна течь в domain.

### 1.7 Rate limiting + circuit breakers

**2026 победитель — Cockatiel** ([Cockatiel npm](https://www.npmjs.com/package/cockatiel)):

```ts
import { Policy } from 'cockatiel'
const epguResilience = Policy.wrap(
  Policy.timeout(10_000),
  Policy.handleAll().retry().attempts(3).exponential(),
  Policy.handleAll().circuitBreaker(60_000, new ConsecutiveBreaker(5)),
  Policy.bulkhead(10, 100), // 10 concurrent, 100 queued
)
const result = await epguResilience.execute(() => client.submit(payload))
```

Альтернатива — Opossum (IBM, focus только circuit breaker).

**Для вас**: уже есть `@ydbjs/retry` для YDB. Для внешних HTTP вызовов — Cockatiel. Все 4 policy для каждой внешней зависимости: timeout + retry + circuit breaker + bulkhead.

### 1.8 Code skeleton для YooKassa (паттерн 2026)

```ts
// domains/payment/provider/yookassa-provider.ts
export interface YookassaConfig {
  shopId: string
  secretKey: string  // sk_test_* OR sk_live_*
  endpoint: string   // 'https://api.yookassa.ru/v3' or sandbox
}
export function createYookassaProvider(cfg: YookassaConfig, deps: {
  http: HttpClient,
  resilience: ResiliencePolicy,
  now: () => Date,
  log: Logger,
}): PaymentProvider {
  return {
    code: 'yookassa',
    capabilities: { /* per ЮKassa real */ },
    async initiate(req) {
      return deps.resilience.execute(async () => {
        const resp = await deps.http.post(`${cfg.endpoint}/payments`, ...)
        return translateYookassaToSnapshot(resp)
      })
    },
    // ...
  }
}

// domains/payment/provider/registry.ts
export function createPaymentProvider(env, deps): PaymentProvider {
  switch (env.PAYMENT_PROVIDER) {
    case 'stub': return createStubPaymentProvider({ delayMs: 0 })
    case 'yookassa': return createYookassaProvider(...)
    default: assertNever(env.PAYMENT_PROVIDER)
  }
}
```

---

## 2. Multi-source booking lock (anti-overbooking)

### 2.1 Что делают Apaleo/Mews/Booking.com

- **Apaleo**: overbooking возможен; визуально подсвечивается красным, manual unblock через "Set Manually Unavailable". **Системно overbooking allowed**, gate UI-уровня.
- **Mews**: diffusive overbooking strategy: lower-type overbook съедается из higher-type. **Известный баг 2026: эта стратегия НЕ форвардится в channel manager** — продаёт через OTA то, что физически уже не доступно.
- **Booking.com Connectivity**: рекомендует **pull reservations every 30s минимум**. Не претендует на real-time consistency.

**Вывод**: индустрия не достигает strict zero-overbooking при multi-channel sales. Цель — **минимизация окна риска + детекция + automated rebook/walk policy**. Это меняет нашу архитектуру: не "прихлопнуть all races", а "сократить окно до <1с + обнаружить residual + автокомпенсация".

### 2.2 Pessimistic vs Optimistic в 2026

- **Pessimistic** (`SELECT FOR UPDATE`) — выбирают legacy banking, payments. Простой, но плохо масштабируется + deadlock prone.
- **Optimistic** (version + check on write) — выбирают современные booking systems. Реагируют на конфликт через retry.

**YDB-specific**: YDB **по умолчанию Serializable + OCC**:
- Reads ставят optimistic locks на observed ranges.
- На commit — проверка locks; если конфликт → `transaction locks invalidated`, transaction rolls back.
- "Транзакция, которая закончилась первой — выигрывает".

**Для вас это подарок**: НЕ пишите вручную `SELECT FOR UPDATE`. Достаточно правильной shape запроса + retry на `TransactionLocksInvalidated`. `@ydbjs/retry` это уже делает.

### 2.3 Distributed lock vs DB-native в YDB

**НЕ используйте Redis Redlock** для booking inventory. YDB сам serializable, а Redlock + database = две границы консистентности с потенциалом split-brain.

**YDB Coordination Service** — semaphore-based leader election, нужен для cron-singleton, **НЕ для booking lock**.

**Recommendation**: используйте YDB native serializable transaction:
1. `SELECT availability WHERE room_type_id=$rt AND date BETWEEN $from AND $to` — read locks.
2. `INSERT INTO booking ...` + `UPDATE availability SET booked = booked + N WHERE ...` — write locks.
3. На commit либо успех, либо `TransactionLocksInvalidated` → retry.

**Critical**: PK `(organization_id, room_type_id, date)` — partitions по `(organization_id, room_type_id)` чтобы lock conflicts были per-room-type, не cross-tenant.

### 2.4 Inventory model

**Канонический выбор 2026 — per-room-type counter**:

```sql
room_type_availability(
  organization_id, room_type_id, date,
  total_qty, booked_qty,
  version Uint64,  -- monotonic, increments on every UPDATE
  PRIMARY KEY (organization_id, room_type_id, date)
)
```

- Конкретная комната назначается at check-in (room assignment) или ночным аудитом.
- Гибкость диффузии (Mews-style) и снятие overhead per-room locks.

**Per-room locking** — для multi-day booking где конкретная комната влияет на consistency. `room_assignment` — отдельный stage после booking confirmed.

### 2.5 Version-based last-write-wins

**Для CDC/outbox обязательно**. Без version поля consumer не может определить "это новейшее или stale".

Запись: `UPDATE ... SET booked_qty = $new, version = version + 1 WHERE ... AND version = $expected`. Если `version != $expected` — другой writer выиграл, retry с reload.

**Channel manager push**: при отправке ARI в OTA версия включается в payload. OTA-side получает несколько push, берёт highest version. Это решает out-of-order delivery.

### 2.6 Reconciliation после race

Когда overbooking всё-таки случился (Booking.com push с задержкой), **индустрия решает не code-фактором, а business policy**:

- **Walk policy** — гость переезжает в равный/лучший отель за наш счёт.
- **Free upgrade** — overbook lower-type, селим в higher-type без доплаты.
- **Manual override** — front desk решает.

**В коде**:
1. Detection: при confirm обнаружен conflict (`booked_qty > total_qty`) → emit `OverbookingDetected` event в outbox.
2. Workflow trigger: alert в notification-domain для admin + UI flag в Шахматке.
3. **НЕ автоматически отменяйте booking** — это бизнес-решение.

### 2.7 Event ordering для ARI sync

**Last writer wins по version** — каноничный выбор 2026. Merged write — overhead не оправдан.

**Booking.com pull every 30s** — обязательная нижняя граница sync с OTA. Eventual consistency в booking — реальность, не bug. Mitigation: гость видит "checking availability" 200ms после клика "book" пока вы fetch-and-confirm с OTA.

---

## 3. Event-driven outbox / CDC patterns

### 3.1 Polymorphic vs per-domain outbox

**Каноничный выбор 2026 для small-medium SaaS — polymorphic outbox + per-domain tables (hybrid)**.

**Polymorphic** = одна таблица `outbox_event(event_id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at)` для всех доменов.

**Pros**:
- Один CDC consumer вместо N.
- Cross-domain ordering trivial — единый `created_at`.
- Cleanup один cron.

**Hybrid 2026 (Microsoft eShop, Confluent)**: одна shared outbox для CDC, но **schema-discriminated payload** через `event_type` + zod registry.

**Для вас** (memory: "polymorphic outbox + activity log = canon") — корректный выбор. Когда дойдёте до 50+ event types — пересмотрите.

### 3.2 Transactional outbox в YDB

**Канонический паттерн 2026**:

1. Producer (booking service) в **одной транзакции**:
   - `INSERT INTO booking ...`
   - `INSERT INTO outbox_event(event_type='booking.confirmed', payload=...)`
2. CDC changefeed на `outbox_event` → YDB topic.
3. Consumer (worker) читает topic → диспатчит в handlers.
4. Идемпотентный handler помечает `processed_at` + audit.

**YDB-specific advantages**:
- `ADD CHANGEFEED` — встроенный CDC, не нужно Debezium.
- Topics — нативный consumer-offset tracking (как Kafka).
- Serializable transaction = atomic outbox write.

**Polling-free**: вы УЖЕ polling-free через CDC + topic consumer. Не меняйте.

### 3.3 Idempotency keys

**Two-tier дедупликация**:
1. **Hot tier — Redis SET NX** с TTL 24h. Fast claim.
2. **Cold tier — DB unique index** `idempotency_key`. Source of truth, не expires.

**Для вас (нет Redis)**: используйте только cold tier. У вас уже `payment.idempotencyKey UNIQUE`.

```ts
async function handleEvent(evt: OutboxEvent) {
  const key = `${evt.aggregate_type}:${evt.event_id}`
  try {
    await sql`INSERT INTO event_processed(key, processed_at) VALUES (${key}, ${now()})`
  } catch (e) {
    if (isUniqueViolation(e)) return // already processed
    throw e
  }
  // proceed with handler
}
```

### 3.4 Event sourcing — НЕ нужен

Event sourcing (rebuild state from events) оправдан когда:
- История изменений = первичный артефакт (banking).
- Нужны time-travel queries.
- Domain экспертам естественно мыслить в событиях.

Для HoReCa (cancellation/refund history через activity log) — current-state модель + immutable event log **достаточно**. Event sourcing добавит:
- Snapshot management.
- Schema migration ад при event versioning.
- Сложность query'ев (CQRS с read models).

### 3.5 Saga: choreography vs orchestration

| Тип | Когда использовать |
|-----|-------------------|
| Choreography | Простые linear flows (≤3 шага), domain events natural |
| Orchestration | Complex workflow, видимость нужна, conditional branches |

**Для booking confirmed → ЕПГУ + notification + KPI**:
- Это **choreography** — каждый handler reacts независимо.
- НЕТ ordering между ними.
- НЕТ compensation flow.

**Когда вводить orchestrator**: payment flow с capture → fiscal receipt → notification, где fail на каком-то шаге **должен** триггерить reverse.

### 3.6 Event versioning

1. **Backward compatible изменения only** в payload schema:
   - Add new field with default.
   - Make field optional.
   - Never rename, never remove (deprecate-then-delete через 2 quarters).
2. **Breaking changes** = новый `event_type`. Например `booking.confirmed.v2`.
3. **Upcasting**: consumer-side translation. `BookingConfirmedV1 → BookingConfirmedV2` в shared package.

**Для вашего стэка**: zod-schema per event_type, registry в `@horeca/shared/events/registry.ts`.

### 3.7 Dead-letter queue

```sql
outbox_event_dlq(
  event_id, aggregate_type, payload,
  error_class,        -- 'permanent' | 'transient_exhausted'
  error_message,
  retry_count,
  first_failed_at,
  last_failed_at,
  manual_replay_at,
)
```

**Принципы**:
1. **НЕ auto-replay из DLQ** — создаёт loop'ы.
2. **Алертинг** — admin notification при первом DLQ entry per event_type per day.
3. **Manual classify+replay UI** — admin читает DLQ → fix root cause → mark for replay.
4. **TTL** — 30 дней для transient_exhausted, NEVER для permanent.

Внутри outbox — поля `attempt_count`, `next_attempt_at`, `last_error`. После 5 attempts — переедет в DLQ.

### 3.8 Outbox cleanup

- Processed events — delete через 7 дней.
- DLQ entries — см. 3.7.
- Activity log — вечно (audit).

В YDB используйте TTL column через `ALTER TABLE ... SET (TTL = ...)`.

### 3.9 OpenTelemetry semconv

OTel attribute names для messaging spans:
- `messaging.system` = `"ydb_topics"`.
- `messaging.operation.type` = `"publish"|"receive"|"process"`.
- `messaging.destination.name` = topic name.
- `messaging.message.id` = ваш outbox event_id.

```ts
const span = tracer.startSpan('outbox.publish', {
  attributes: {
    'messaging.system': 'ydb_outbox',
    'messaging.operation.type': 'publish',
    'messaging.message.id': eventId,
    'outbox.event_type': evt.type,
    'outbox.aggregate_type': evt.aggregateType,
  },
})
```

---

## 4. Конкретные библиотеки 2026

| Need | Choice | Почти: | Avoid |
|------|--------|---------|-------|
| Provider pattern | interface + factory function | tsyringe (если 10+) | inversify (heavy) |
| Circuit breaker | **Cockatiel** | Opossum | hand-rolled |
| Retry general HTTP | **Cockatiel** + jitter | p-retry | manual loop |
| Retry YDB | `@ydbjs/retry` | — | Cockatiel (YDB-specific уже есть) |
| Feature flags | **OpenFeature** + Flagd dev / Unleash prod | Vercel Flags SDK | LaunchDarkly direct |
| Contract test | nock cassettes | Pact (overkill) | manual mocks |
| Schema validation | zod | yup | ajv |
| OTel semconv | semantic-conventions ≥1.40.0 | older | custom names |

---

## 5. Specific patterns для нашего сценария

### 5.1 NODE_ENV vs adapter mode

`NODE_ENV ∈ {development, test, production}` — **только для build-time** решений. Adapter selection — **отдельная переменная per adapter**:

```
NODE_ENV=production
PAYMENT_PROVIDER=yookassa
EPGU_PROVIDER=stub         # OK during МВД-доступ ожидание; whitelist в startup
CAPTCHA_PROVIDER=smartcaptcha
NOTIFICATION_PROVIDER=postbox
```

**Staging**:
```
NODE_ENV=production  # код видит prod build
PAYMENT_PROVIDER=yookassa  # sandbox keys
EPGU_PROVIDER=stub
ADAPTER_MODE_OVERRIDE=staging
```

Не вводите `NODE_ENV=staging` — ломает половину npm-пакетов.

### 5.2 Coherent mocks друг с другом

Если booking confirmed → ЕПГУ stub возвращает confirmed → KPI worker reads confirmed:

1. **Stub adapters пишут в реальный YDB**, не в in-memory. ЕПГУ-stub: `insertEpguSubmission(bookingId, status='submitted')`.
2. **CDC pipeline идентичен** для stub и real. Workers не знают, что upstream был stub.
3. **Handlers НЕ зависят от provider mode** — они читают persisted state.

`EpguAdapter.submit()` для stub НЕ просто returns success — он **записывает в `epgu_submission` таблицу**, как сделал бы real.

---

## 6. Failure modes и graceful degradation

### 6.1 Mock возвращает service_unavailable

- **Защита**: ЕПГУ submission НЕ блокирует booking confirm. Booking confirms → outbox event → ЕПГУ-handler picks up async.
- Если ЕПГУ-handler fails → retry с backoff → DLQ → admin alert.

### 6.2 YooKassa webhook потерян

- **Reconciliation cron** (5min): `SELECT payments WHERE status='pending' AND created_at < NOW() - 10min`. Для каждого — `provider.fetchStatus()`.
- **Idempotent reconciliation** — `provider.fetchStatus()` через тот же handler → idempotency-key gate prevents duplicate.
- Stripe + индустрия 2026 единогласно делают reconciliation polling **поверх** webhooks. Webhook is best-effort, polling is source of truth.

### 6.3 Channel manager rate limit

**Backpressure pattern**:
1. **Bulkhead** — max 10 concurrent push per provider.
2. **Token bucket** — `p-throttle` или Cockatiel rate-limit policy.
3. Если queue filled — events stay в outbox, retry на следующем tick.
4. **Health check**: monitor outbox depth per channel manager. Alert если >100 events stuck >5min.

### 6.4 Cascading failures

**Защита**:
1. **Timeout per operation** — Cockatiel `timeout(10_000)`.
2. **Circuit breaker** — после 5 fails открывается на 60s.
3. **Bulkhead** — концурентность лимитирована per adapter.
4. **Async-by-default** — adapter calls в outbox handlers, не в request path.

---

## 7. Открытые вопросы

1. **YDB CDC offset reliability** — публичных деталей мало. Перед production switch — load-test (10k events) с restart consumer. **Action**: создайте `apps/backend/tests/cdc-offset-recovery.test.ts` до M+ deploy.
2. **Yandex Cloud Postbox sender domain promotion** — определите процедуру + lead time до infra-фазы.
3. **EpguAdapter contract** — XML schema МВД меняется по приказам. VCR cassettes от первого реального успешного submission — единственный baseline.
4. **Multi-tenant rate limits per provider** — YooKassa имеет общие лимиты на merchant'а. Если 100 tenants — один с DDoS на checkout положит всех. Нужен **per-tenant token bucket** дополнительно к per-provider bulkhead.
5. **Mews diffusive overbooking-style** — реализуем ли в Шахматке для V1? Бизнес-решение, влияет на schema.

---

## 8. Источники

**Адаптеры/Stripe/AWS:**
- [Stripe sandboxes](https://docs.stripe.com/sandboxes), [API keys](https://docs.stripe.com/keys), [Stripe go-live](https://docs.stripe.com/get-started/checklist/go-live)
- [Apaleo overbooking help](https://apaleo.zendesk.com/hc/en-us/articles/360009197699-How-Do-I-Prevent-Overbookings)
- [Mews Connectivity feedback](https://feedback.mews.com/forums/955688-connectivity)

**Booking.com / Channels:**
- [Booking.com ARI overview](https://developers.booking.com/connectivity/docs/ari)
- [Booking.com implementation](https://portal.connectivity.booking.com/s/article/How-can-I-implement-the-Rates-Availability-API-and-Reservations-API)

**YDB:**
- [YDB transactions](https://ydb.tech/docs/en/concepts/transactions?version=v25.2)
- [YDB CDC concepts](https://ydb.tech/docs/en/concepts/cdc)
- [YDB distributed lock recipe](https://ydb.tech/docs/en/recipes/ydb-sdk/distributed-lock)

**Outbox/CDC:**
- [microservices.io transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Confluent CDC patterns](https://www.confluent.io/blog/how-change-data-capture-works-patterns-solutions-implementation/)
- [eShopOnContainers](https://github.com/dotnet-architecture/eshoponcontainers/wiki/Architecture)

**Resilience:**
- [Cockatiel npm](https://www.npmjs.com/package/cockatiel)
- [APIScout 2026 resilience](https://apiscout.dev/blog/api-resilience-circuit-breakers-retries-bulkheads-2026)

**Feature flags:**
- [OpenFeature 2026 guide](https://1xapi.com/blog/feature-flags-nodejs-openfeature-2026-guide)

**OTel:**
- [OTel semconv 1.40.0](https://opentelemetry.io/docs/specs/semconv/)
- [OTel messaging](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)
