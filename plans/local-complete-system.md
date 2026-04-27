# План «Полностью рабочая локальная система до M8»

**Дата составления:** 2026-04-27
**Автор и единственный ответственный:** ed (senior + lead + product в одном лице)
**Цель:** довести систему до состояния production-grade с полным покрытием 7 функций мандата Алисы и сопутствующего compliance-набора, при котором единственное, что отделяет нас от продакшна — это переключение адаптеров с моков на реальные внешние сервисы.

---

## 0. Зачем этот документ

Это рабочий план следующих фаз работы (условные M8.A — M8.G), которые предшествуют реальным внешним интеграциям и деплою. Документ — single source of truth для всей этой работы. Любое отклонение от плана → правка плана сначала, потом код.

---

## 1. Главная цель и не-цель

### Цель (priority 1)

Построить **полностью рабочую систему**, которая закрывает все 3 боли малого HoReCa Сочи end-to-end в локальном окружении. Каждая внешняя интеграция реализована через адаптер с моком, который **на 100% поведенчески идентичен** реальному сервису. Подключение реального API в M8+ — это замена адаптера, а не дописывание функционала.

### Не-цель

**Демо — не цель**, а побочный артефакт по пути. Мы не упаковываем витрину, мы строим продукт, который потом просто переключается на реальные внешние сервисы.

### Критерий «готово к M8»

После этой фазы любой инженер должен иметь возможность:

- Запустить `pnpm infra:up && pnpm migrate && pnpm dev` и пройти **полный пользовательский путь** (заселение иностранного гостя со сканом паспорта → отправка в МВД → подтверждение → бронирование с виджета → оплата → уведомления → расчёт KPI → отчёт по тур.налогу → синхронизация с каналом продаж) **без ручного вмешательства**.
- Каждый внешний вызов идёт через адаптер, который воспроизводит все ошибки, тайминги и асинхронность реальных систем.
- Переключение `APP_MODE=production` мгновенно отказывает в старте, если хоть один адаптер в режиме мока.

---

## 2. Принципы инженерии (обязательные, без исключений)

### 2.1. Behaviour-faithful моки

Мок ≠ заглушка. Каждый мок-адаптер обязан воспроизводить:

- **Формат запросов и ответов** до уровня поля, типа, обязательности, max length.
- **Коды ошибок** реального API (включая редкие: rate-limit, fraud_detected, конфликт ЭЦП, недоступность).
- **Тайминги**: синхронные ответы — задержка 50–500 мс с jitter; асинхронные подтверждения — задержка от секунд до минут (через cron/timer); webhook-callbacks через настраиваемый delay.
- **Идемпотентность** (если она есть в реальном API).
- **Пейджинацию, лимиты, троттлинг**.
- **Eventual consistency**: иногда мок возвращает stale-данные, чтобы наш код был к этому готов.
- **Подписи / OAuth-токены / ЭЦП** на уровне формата (валидация структуры, не содержимого).

Принцип: **«если завтра подключим реальный API, и он сломает наш код — значит мок был неправильный»**. Перепишем мок, а не код.

### 2.2. Адаптер-паттерн с двумя реализациями

Для каждой внешней интеграции:

```
domains/{domain}/adapter/
  {Adapter}.ts          // interface
  {Adapter}MockImpl.ts  // behaviour-faithful mock
  {Adapter}HttpImpl.ts  // empty stub, throws "not implemented in M8"
  {Adapter}.factory.ts  // chooses by env flag MODE+ADAPTER_KIND
  {Adapter}MockImpl.test.ts // тесты на сам мок (в т.ч. что он реалистичен)
```

Уже работающий пример — `apps/backend/src/domains/payment/provider/stub-provider.ts`. Распространяем подход на все интеграции.

### 2.3. Empirical research перед каждым моком

Перед написанием первой строчки кода адаптера — отдельный ресерч-заход (web-search + чтение документаций + реальные примеры). Результат — markdown-файл `plans/research/{integration}.md` с:

- Каноническим описанием API (endpoints, методы, форматы).
- Примерами реальных запросов/ответов (raw XML/JSON).
- Полной таблицей кодов ошибок.
- Описанием асинхронных flows.
- Описанием edge-cases: rate-limit, частичные сбои, дубли.
- Каноническим списком источников.

**Без этого файла мок не пишется.** Ресерч — отдельный коммит, отдельный PR. После ресерча — пользователь подтверждает, что покрытие достаточное, только потом начинается код мока.

### 2.4. Production-grade с первой строчки

В соответствии с [feedback_engineering_philosophy.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_engineering_philosophy.md): пишем сразу как для прода, не отшлифовываем потом. Каждая страница — RBAC × cross-tenant × valid-input × invalid-input × adversarial. Каждый воркер — ретраи × idempotency × outbox × CDC. Каждый эндпоинт — zod-валидация × audit-log × rate-limit (на публичных).

### 2.5. Strict tests

Канон [feedback_strict_tests.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_strict_tests.md): тесты ищут баги, не подстраиваются под код. Exact-value asserts, adversarial negative paths, immutable-field checks. Сюда добавляется новое: **тесты должны проверять поведенческую достоверность мока против документации реального API** (если документация описывает «возвращает 422 при дубле» — мок обязан возвращать 422 при дубле, и тест это проверяет).

### 2.6. Automate every check

[feedback_automate_every_check.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_automate_every_check.md). Каждая ручная проверка после фичи — техдолг. До закрытия подфазы каждый ручной curl/manual-test превращается в pre-commit или pre-push gate.

### 2.7. Aggressive de-legacy + dependency freshness

В конце каждой подфазы — npm-registry аудит ([feedback_dependency_freshness.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_dependency_freshness.md)). Любой устаревший паттерн → переписать.

### 2.8. Pre-done audit gate

Каждая подфаза заканчивается paste-and-fill чек-листом [feedback_pre_done_audit.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_pre_done_audit.md): cross-tenant × every method, RBAC × every role, enum FULL coverage, null vs undefined patches, UNIQUE collision per index, gotchas applied. Без чек-листа фаза не считается закрытой.

### 2.9. No half-measures

[feedback_no_halfway.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_no_halfway.md). Делаем полностью. Не «сделаем потом». Не глушим ошибки через ignore. Не downscope’им молча — если меняем скоп, правим план сначала.

### 2.10. Sandbox/Production режим

Новый сквозной механизм — раздел 4.E.

---

## 3. Текущий фактический статус (по коду на 2026-04-27)

Проверка через grep+ls по репозиторию, не по памяти.

| # | Функция мандата | Backend | Frontend | End-to-end | Закрытие боли |
|---|---|---|---|---|---|
| 1.1 | Госуслуги (Скала-ЕПГУ) | ❌ только поле `registrationStatus` в комментарии [packages/shared/src/guest.ts:16](../packages/shared/src/guest.ts#L16) | ❌ | ❌ | Боль 1 — 0% |
| 1.2 | AI-сканер паспортов (Yandex Vision) | ❌ | ❌ ручной ввод | ❌ | Боль 1 — 0% |
| 2.1 | Шахматка | ✅ M3-M4 [booking + availability + atomic overbooking](../apps/backend/src/domains/booking/) | ✅ M5 [features/chessboard/](../apps/frontend/src/features/chessboard/) + [routes/_app.o.$orgSlug.grid.tsx](../apps/frontend/src/routes/_app.o.$orgSlug.grid.tsx) | ✅ | Боль 2 — 33% |
| 2.2 | Channel Manager | ❌ ничего по TravelLine/Я.Путешествия/Ostrovok/Bnovo | ❌ | ❌ | Боль 2 — 0% |
| 2.3 | Public widget + платежи | 🟡 платёжный домен M6 ([apps/backend/src/domains/payment/](../apps/backend/src/domains/payment/)) — но провайдер только stub ([provider/stub-provider.ts](../apps/backend/src/domains/payment/provider/stub-provider.ts)). Публичных роутов в [app.ts](../apps/backend/src/app.ts) нет | ❌ | ❌ | Боль 2 — 0% |
| 3.1 | KPI Dashboard | ❌ | ❌ (решение через Yandex DataLens отложено) | ❌ | Боль 3 — 0% |
| 3.2 | Email/SMS уведомления | ✅ M7.A+B шаблоны + диспетчер + Postbox/Mailpit | ✅ M7.fix.3.d админ-консоль | ✅ | Боль 3 — 50% |
| Бонус | Туристический налог 2% | ✅ M7.A.3 авто-начисление | ✅ M7.fix.3.b XLSX export + KPI cards | ✅ | Compliance closed |

**Итог на старте этой фазы:** 0 из 3 болей закрыты полностью end-to-end. 2 функции из 7 закрыты. Туристический налог закрыт бонусом (RU-compliance). Это и есть отправная точка.

---

## 4. Состав фазы — 7 подфаз M8.A — M8.G

Нумерация продолжает существующую (M7.A/M7.B/M7.fix.3 уже использованы). Каждая подфаза — отдельный feature-branch и отдельный PR, или несколько PR при крупном объёме.

| Подфаза | Что закрывает | Ориентир по времени |
|---|---|---|
| **M8.A** | ЕПГУ адаптер + AI passport + страница миграционного учёта | 2.5–3 недели |
| **M8.B** | Public widget + YooKassa адаптер + 54-ФЗ фискализация | 2.5–3 недели |
| **M8.C** | Channel Manager: 3 канала (TravelLine + Я.Путешествия + Ostrovok) | 3–4 недели |
| **M8.D** | KPI domain + native UI + DataLens-готовность | 1–1.5 недели |
| **M8.E** | Sandbox/Production gate + adapter factories + observability | 1 неделя |
| **M8.F** | Документация интеграций + сидеры + видео-walkthroughs | 1 неделя |
| **M8.G** | Финальный кросс-функциональный аудит готовности к M8 | 3–5 дней |
| **Итого** | **6 функций мандата + 2 уже закрыты + sandbox-инфра** | **~10–13 недель** |

Параллелизация подфаз ограничена — слишком много общих абстракций и риск merge-конфликтов на factory-слоях.

---

## 4.A. Подфаза M8.A — ЕПГУ + РКЛ + AI passport

### 4.A.1. Какую боль закрывает

**Боль 1 — миграционный учёт + штрафы.** Функции мандата 1.1 + 1.2 (парные).

Сценарий end-to-end (целевой):

1. Иностранный гость на стойке.
2. Оператор открывает новое бронирование, нажимает «Сканировать паспорт».
3. Камера или drag-n-drop фото → OCR → автозаполнение анкеты.
4. Оператор корректирует/подтверждает.
5. Нажатие «Сохранить и отправить в МВД» → CDC → outbox → ЕПГУ-адаптер → асинхронное подтверждение.
6. Статус регистрации в реальном времени на странице «Миграционный учёт».
7. РКЛ-проверка (контролируемые лица) до заселения.
8. При ошибке — retry, manual submit, видимая причина.

### 4.A.2. Внешние системы (ресерч-чек-лист)

**Файл ресерча:** `plans/research/epgu.md`, `plans/research/yandex-vision-passport.md`, `plans/research/rkl.md`.

Перед началом кода — для каждой внешней системы прочитать и зафиксировать:

#### ЕПГУ (Скала-ЕПГУ)

- Постановление №1668 — полный текст, штрафы, обязанности.
- Приказ ФНС/МВД о форме передачи данных (актуальный на 2026).
- Контур.Отель статья — реальные примеры workflow.
- TravelLine гайд `shag-3-nastroyka-api-epgu-gosuslugi`.
- Bnovo гайд `help.bnovo.ru/knowledgebase/skala`.
- Журнал «Бронируй-онлайн» статья «Миграционный учёт в отеле».
- Спецификация формата XML (поля анкеты гостя, документы, визы, гражданство, регистрация).
- ЭЦП-сертификаты: какие нужны, кто выдаёт, OAuth-флоу к Госуслугам.
- Асинхронность: как ЕПГУ возвращает подтверждение (webhook? polling? время задержки в реальной практике).
- Коды ошибок: валидация, дубли, временная недоступность, RKL отказ, неверный сертификат.
- Лимиты: rate-limit, размер batch, частота submission.
- РКЛ (реестр контролируемых лиц): отдельный API (через Контур или прямо к ФМС-реестру) — сравнение, какой выбрать.

#### Yandex Vision (модель `passport`)

- Документация `yandex.cloud/ru/docs/vision/concepts/ocr/passport`.
- Endpoint, формат запроса (multipart? base64?), формат ответа.
- Поддерживаемые типы документов (паспорт РФ внутренний, заграничный, паспорта СНГ, водительские).
- Confidence-метрики: какие поля и какая шкала.
- Как Vision возвращает ошибки: невалидное изображение, неподдерживаемый документ, недоступность.
- Требования к качеству фото (min DPI, освещение).
- Биллинг: единица тарификации.
- Альтернативы для fallback (нет — Yandex Cloud only).

#### 152-ФЗ (обработка персональных данных)

- Требования к согласию гостя (отдельный документ от ToS, обновление 2025-09-01).
- Retention policy для фото паспортов.
- Шифрование at rest.
- Логирование доступа.

### 4.A.3. Контракт мока (после ресерча)

#### EpguAdapter

```ts
interface EpguAdapter {
  submit(submission: EpguSubmissionInput): Promise<EpguSubmissionAck>
  // Ack приходит сразу (sync 200/4xx/5xx)
  // Подтверждение/отказ — асинхронно через poll или webhook (мок имитирует через timer)

  pollStatus(submissionId: string): Promise<EpguSubmissionStatus>
  // 'pending' | 'confirmed' | 'rejected' | 'permanent_failed' + reason

  cancel(submissionId: string): Promise<void>
  // если ЕПГУ поддерживает отмену — узнаем из ресерча
}
```

#### EpguAdapterMockImpl поведение

- Возвращает `Ack` через 100–500 мс jitter.
- В 5% случаев — `503 temporarily_unavailable` (тестируется retry).
- В 2% случаев — `422 invalid_signature` (тестируется обработка).
- Confirmation через timer:
  - 90% — `confirmed` через 30–120 секунд.
  - 5% — `rejected` (RKL match, дубль, неверные данные).
  - 5% — `permanent_failed` (сертификат отозван).
- Идемпотентность через `submission.requestId` (UUID): повторный submit с тем же UUID → возврат сохранённого ack.
- Хранит state в памяти (модуль-локальный Map) для всего lifecycle, не SQLite/файл.

#### VisionAdapter

```ts
interface VisionAdapter {
  recognizePassport(image: Buffer, hints: { documentType: PassportKind }): Promise<PassportOcrResult>
}
type PassportOcrResult = {
  fields: Record<PassportField, { value: string; confidence: number }>
  rawResponse: unknown // для debug
}
```

#### VisionAdapterMockImpl поведение

- Принимает изображение, проверяет размер/тип (50KB–10MB, jpeg/png).
- Возвращает hardcoded набор «тестовых паспортов» по hash изображения.
- Confidence: 0.95–0.99 для обычных полей, 0.6–0.85 для рукописных полей (адрес).
- В 3% случаев — `422 unsupported_document_type`.
- В 2% случаев — `503 service_unavailable`.
- Задержка 800–2500 мс (Vision реалистично медленный).

#### RklAdapter

```ts
interface RklAdapter {
  check(document: RklCheckInput): Promise<RklCheckResult>
}
type RklCheckResult = { status: 'clear' | 'match' | 'inconclusive'; reason?: string; checkedAt: Date }
```

#### RklAdapterMockImpl поведение

- 99% случаев — `clear`.
- 0.5% — `match` с фейковой причиной.
- 0.5% — `inconclusive` (требует ручной проверки).
- Задержка 200–800 мс.

### 4.A.4. Schema (миграции)

Новая миграция `apps/backend/src/db/migrations/0021_migration_registration.sql`:

```
guest_document
  id (typeid prefix gdoc)
  guestId (FK)
  documentType (enum: ru_passport_internal, ru_passport_international, foreign_passport, driver_license, ...)
  series, number, issuedBy, issuedAt, expiresAt
  citizenship (ISO 3166-1 alpha-3)
  visaNumber, visaIssuedAt, visaExpiresAt (nullable)
  arrivalDate, arrivalPlace, arrivalPurpose (nullable, для иностранцев)
  ocrResult (JSON, со списком полей и confidence)
  ocrSourceImageS3Key (nullable, ссылка на Object Storage)
  consent152fzGivenAt
  createdAt, updatedAt
  PK (tenantId, id)

guest_registration
  id (typeid prefix greg)
  tenantId
  bookingId (FK)
  guestId (FK)
  documentId (FK)
  status (enum: draft, pending, submitted, confirmed, rejected, permanent_failed, cancelled)
  epguSubmissionId (nullable, после первого submit)
  epguRequestId (idempotency UUID)
  rklStatus (enum: not_checked, clear, match, inconclusive)
  rklCheckedAt
  attempts (JSON array, как notification.attempts)
  errorReason (nullable)
  createdAt, updatedAt, submittedAt, confirmedAt
  PK (tenantId, id)
  Index по (tenantId, status, createdAt) для admin-страницы
  Index по bookingId

guest_registration_outbox
  id, tenantId, registrationId (FK)
  payload (JSON)
  status (pending, in_flight, sent, failed)
  retryCount, nextAttemptAt
  CDC consumer на booking_confirmed → enqueue
```

Новая миграция `0022_passport_ocr_audit.sql` — аудит OCR-вызовов, retention 90 дней.

### 4.A.5. Backend

**Domains:**

- `domains/migration-registration/` (новый): repo, service, routes, factory.
  - service: `submitRegistration(bookingId, guestId, documentId)` → создать запись + enqueue в outbox.
  - service: `retry(registrationId)` → reset attempts, enqueue.
  - service: `manualSubmit(registrationId)` → принудительный re-submit.
  - service: `list(filters)` → курсорная пагинация (повторяем паттерн notifications).
  - service: `getById(id)` → детали + attempts[].
- `domains/passport-ocr/` (новый): VisionAdapter wrapper.
  - service: `scan(image, hints)` → mock или real.
  - service: загрузка в Object Storage (mock S3 = MinIO в локалке) с TTL.
- `domains/rkl/` (новый): RklAdapter wrapper.

**Workers:**

- `workers/migration-registration-cdc.ts`: CDC consumer на `booking_confirmed` (если гость иностранный, регион требует МВД-учёта) → создаёт draft registration + сохраняет hint оператору.
- `workers/migration-registration-dispatcher.ts`: воркер на outbox → call EpguAdapter.submit.
- `workers/migration-registration-poller.ts`: cron каждую минуту → poll pending submissions через EpguAdapter.pollStatus.
- Все воркеры через `concurrencyKey` чтобы не было дублей submit.

**Routes:**

- `routes/admin/migration-registration.ts`:
  - `GET /api/admin/migration-registrations` (list, filters: status, dateRange, propertyId).
  - `GET /api/admin/migration-registrations/:id` (детали).
  - `POST /api/admin/migration-registrations/:id/retry` (manual retry, RBAC: manager/owner).
  - `POST /api/admin/migration-registrations/:id/manual-submit` (force resubmit).
- `routes/v1/passport.ts`:
  - `POST /api/v1/passport/scan` (multipart, fileSize cap, RBAC: staff/manager/owner).
- `routes/v1/rkl.ts`:
  - `POST /api/v1/rkl/check` (RBAC).

### 4.A.6. Frontend

**Routes:**

- `routes/_app.o.$orgSlug.admin.migration.tsx` — страница «Миграционный учёт».
  - Таблица гостей со статусами регистрации.
  - Фильтры (статус, период, объект размещения, иностранный/российский).
  - URL-addressable Sheet drill-down (`?id=greg_xxx` — паттерн notifications).
  - Кнопки retry, manual submit (RBAC).
- В существующей странице бронирования добавить:
  - Кнопка «Сканировать паспорт» в форме заселения.
  - Drag-n-drop / file input / camera capture (через WebRTC navigator.mediaDevices.getUserMedia).
  - Preview изображения.
  - Submit → spinner → autofill полей анкеты.
  - Confidence-индикаторы у автозаполненных полей (визуально: голубая рамка 0.95+, жёлтая 0.7–0.95, красная <0.7 — fallback на ручной ввод).
  - Кнопка «Зарегистрировать в МВД» (после сохранения бронирования) → создаёт guest_registration draft + автоматически submit при confirmed booking.

**Features:**

- `features/admin-migration/` — таблица + filter-bar + sheet (по паттерну admin-notifications).
- `features/passport-scanner/` — компонент сканирования + preview + autofill hooks.
- Согласие 152-ФЗ — модальное окно при первом OCR на гостя, сохранение `consent152fzGivenAt`.

### 4.A.7. RBAC расширение

Обновить `packages/shared/src/rbac.ts`:

- `migrationRegistration`: `read` (staff/manager/owner), `retry` (manager/owner), `manualSubmit` (manager/owner).
- `passportScan`: `execute` (staff/manager/owner).
- `rklCheck`: `execute` (staff/manager/owner).

Activity log: расширить `objectType` на `migration_registration`, `activityType` на `submitted | confirmed | rejected | retried | manuallySubmitted`.

### 4.A.8. Тесты (strict)

#### Backend

- **Unit на EpguAdapterMockImpl:** все 5% и 2% сценарии (явно прокидываем seed для детерминизма), idempotency, async confirmation timer.
- **Integration тесты:**
  - `[A1]` happy path: бронь иностранца → CDC → outbox → submit → poll → confirmed.
  - `[A2]` retry on 503: первая попытка fail, через 30 сек retry succeeds.
  - `[A3]` permanent_failed: 3 попытки исчерпаны → status permanent_failed → activity log.
  - `[A4]` RKL match → блокировка регистрации до manual decision.
  - `[A5]` cross-tenant: tenant A не видит регистрации tenant B (× все 3 endpoint).
  - `[A6]` RBAC: staff не может retry, только read.
  - `[A7]` idempotency: повторный submit с тем же requestId не создаёт дубль.
  - `[A8]` cancel booking → cancel регистрации.
  - `[A9]` immutable fields: после confirmed нельзя править submission.
- **OCR integration:**
  - `[O1]` scan → realistic fields → autofill in booking creation.
  - `[O2]` low confidence (<0.7) → mandatory manual review flag.
  - `[O3]` 503 → graceful fallback на ручной ввод.
  - `[O4]` неподдерживаемый documentType → 422.
  - `[O5]` >10MB → reject.
  - `[O6]` 152-ФЗ согласие отсутствует → 403.

#### Frontend

- Component тесты на passport-scanner, admin-migration table, sheet, retry-gate.
- Property-based тесты на pure helpers (если будут).
- Playwright e2e: полный сценарий заселения иностранца.
- axe-core a11y gate на новой странице.

### 4.A.9. Pre-done checklist (M8.A)

```
[ ] Ресерч-файлы plans/research/epgu.md, yandex-vision-passport.md, rkl.md созданы и прочитаны
[ ] Cross-tenant × все 8 endpoints (включая RKL и passport)
[ ] RBAC × все 3 роли × все методы (read, retry, manualSubmit, scan, rklCheck)
[ ] EpguMockImpl: проверены все 5%/2% ветки (seed-based determinism)
[ ] Idempotency на submit (повтор с тем же requestId)
[ ] Async confirmation flow (poller cron работает)
[ ] CDC outbox + retry policy + permanent_failed после N попыток
[ ] Activity log на каждое state-change
[ ] axe-core green на /admin/migration page и в booking-create dialog
[ ] 152-ФЗ согласие (модалка + сохранение consent152fzGivenAt)
[ ] OCR confidence indicators visible
[ ] OCR fallback на manual input
[ ] Object Storage TTL для фото паспортов
[ ] Все ручные curl/test заменены автоматическими гейтами
[ ] pnpm test:serial green
[ ] pnpm build green
[ ] pnpm e2e:smoke green
[ ] pnpm coverage не упало ниже floor
[ ] Memory обновлена: project_epgu_integration_pending → project_migration_registration_done; project_ai_passport_pending → done
[ ] План обновлён (статус M8.A → done)
```

---

## 4.B. Подфаза M8.B — Public widget + платежи + 54-ФЗ

### 4.B.1. Какую боль закрывает

**Боль 2 — овербукинг + продажи**, функция 2.3.

Сценарий end-to-end:

1. Гость заходит на сайт отеля (страница виджета или iframe).
2. Поиск номеров: даты, гости, фильтры.
3. Выбор номера + тарифа + дополнительных услуг.
4. Заполнение контактов.
5. Оплата картой / СБП через YooKassa.
6. 3DS challenge при необходимости.
7. Подтверждение → бронирование создано → email с ваучером (через notification system).
8. Webhook от YooKassa → фискализация чека (54-ФЗ) → сохранение receipt.
9. Возврат / cancellation flow.

### 4.B.2. Внешние системы (ресерч-чек-лист)

**Файлы:** `plans/research/yookassa.md`, `plans/research/cloudpayments.md`, `plans/research/54fz-fiscal.md`, `plans/research/yandex-smartcaptcha.md`, `plans/research/widget-best-practices.md`.

#### YooKassa

- API 2026: создание платежа, capture/cancel split, частичная оплата.
- Webhooks: events, retry policy, signature verification.
- 3DS-флоу: на стороне клиента (redirect) vs API.
- СБП поддержка.
- Recurring payments (для tips/upsell позже).
- Idempotence-Key header.
- Тестовые карты (sandbox).
- Errors: insufficient_funds, fraud_detected, expired_card, 3ds_authentication_failed.
- Comissions, settlement timing.
- Refund: full, partial, частичная по позициям чека.

#### CloudPayments

- Только как backup-вариант. Сравнить интерфейс с YooKassa.
- Решить: один провайдер или два с runtime-выбором.

#### 54-ФЗ фискализация

- Какие данные обязательны в чеке (позиции, ставка НДС, признак агента, email/phone клиента).
- Через что фискализируется: Атол.Онлайн, OFD.ru, ОФД-Я, Чеки от YooKassa.
- YooKassa Чеки — embedded option (рекомендация для нас).
- Регистрация на ОФД-сервисе.
- Receipt format: тип, агент, items, taxation_system.
- Возврат чека (refund receipt).

#### Yandex SmartCaptcha

- Защита публичных endpoints.
- Frontend integration (script tag).
- Backend verify endpoint.
- Lifecycle токенов.

#### Widget best-practices

- Bnovo widget анализ (UX, технологии).
- TravelLine widget анализ.
- Ostrovok engine анализ.
- Apaleo Booking Engine анализ.
- iframe vs script-injection.
- Mobile-first паттерны.
- A11y публичного виджета.
- SEO (виджет должен быть индексируем при iframe? Это проблема, sitemap для отеля отдельно).

### 4.B.3. Контракт мока

#### PaymentAdapter (расширение существующего stub-provider)

```ts
interface PaymentAdapter {
  createPayment(input: CreatePaymentInput): Promise<PaymentCreated>
  capture(paymentId: string, amount?: Money): Promise<PaymentCaptured>
  cancel(paymentId: string): Promise<PaymentCancelled>
  refund(input: RefundInput): Promise<RefundCreated>
  getPayment(id: string): Promise<PaymentState>
  // webhook simulation: setTimeout-based внешний sender в моке
}
```

#### YooKassaMockImpl поведение

- `createPayment` возвращает `PaymentCreated` с `confirmation_url` (mock-страница 3DS).
- 3DS challenge: 30% запросов требуют 3DS, mock-страница "Подтвердите оплату" (simulated form).
- Webhook через 2–10 секунд после createPayment (mock dispatcher с timer).
- Webhook signature через HMAC-SHA256 (мы делаем то же что YooKassa).
- 5% — `payment.canceled` (insufficient_funds).
- 2% — `3ds_authentication_failed`.
- 1% — `fraud_detected`.
- Idempotence: повторный createPayment с тем же Idempotence-Key → возврат существующего платежа.
- Receipt: после succeeded — fiscal receipt mock через 5–30 секунд.
- Refund: synchronous, но с шансом задержки fiscal receipt до 60 секунд.

#### FiscalAdapter

```ts
interface FiscalAdapter {
  registerReceipt(input: ReceiptInput): Promise<ReceiptRegistered>
  registerRefundReceipt(input: RefundReceiptInput): Promise<ReceiptRegistered>
  getReceipt(id: string): Promise<ReceiptState>
}
```

#### FiscalAdapterMockImpl поведение

- Ack через 200–800 мс.
- Fiscal Document Number генерируется realistic (16-digit).
- 3% — `503 ofd_unavailable` (retry).
- 1% — `422 invalid_taxation_system` (нужно настроить tenant).

### 4.B.4. Schema

Новая миграция `0023_public_booking.sql`:

```
public_booking_intent
  id (typeid prefix bki)
  propertyId
  searchQuery (JSON: dates, guests, filters)
  selectedRoomTypeId, selectedRatePlanId, selectedAddons
  guestContacts (JSON: name, phone, email)
  status (draft, payment_pending, paid, confirmed, expired, cancelled)
  expiresAt (15 минут TTL)
  paymentId (FK после создания)
  bookingId (FK после confirmed)
  createdAt, updatedAt

public_session
  id (cookie/jwt)
  fingerprint (browser hash)
  rateLimitBucket
  createdAt
```

Расширения существующих таблиц: payment-domain уже готов, но добавить:

- payment.source = 'admin' | 'public_widget' | 'channel_manager'
- receipt.fiscalDocumentNumber, receipt.ofdProvider

### 4.B.5. Backend

**Public routes (новый namespace `/api/public`):**

- `GET /api/public/properties/:slug` — публичные данные отеля (название, описание, фото, контакты).
- `POST /api/public/availability/search` — поиск доступности.
- `POST /api/public/booking-intent` — создать draft intent (rate-limited, captcha).
- `POST /api/public/booking-intent/:id/confirm` — подтвердить выбор номера.
- `POST /api/public/booking-intent/:id/payment` — создать платёж через YooKassaAdapter.
- `POST /api/public/payment-webhook/yookassa` — webhook receiver (HMAC verify).
- `GET /api/public/booking/:reference` — статус по reference (без auth, через email link).

**Middleware публичных эндпоинтов:**

- Rate-limit (token bucket по IP + fingerprint).
- Captcha verify (Yandex SmartCaptcha).
- Tenant resolve по property slug.

**Workers:**

- Webhook handler — обработка YooKassa events (idempotency через event_id).
- Booking confirmation worker: paid → создать `booking` через существующий booking domain → trigger fiscal receipt → trigger notification.
- Expired intent cleanup cron.

### 4.B.6. Frontend

**Public app (новая SPA или роуты):**

Решение: отдельный `apps/widget/` или `routes/widget/` в существующем frontend? Open question (см. §6).

- `/widget/{propertySlug}` — entry-point виджета.
- `/widget/{propertySlug}/search` — поиск.
- `/widget/{propertySlug}/select` — выбор номера и тарифа.
- `/widget/{propertySlug}/details` — анкета гостя + addon-ы.
- `/widget/{propertySlug}/payment` — оплата (YooKassa SDK или iframe).
- `/widget/{propertySlug}/confirmation` — подтверждение.
- Mobile-first дизайн.
- a11y — обязательно axe-core green (это публичный продукт, фронтальная зона риска).
- i18n: только RU.

### 4.B.7. Тесты

- E2E: полный публичный флоу (search → select → details → payment → confirmation), обычная карта.
- E2E: 3DS-флоу.
- E2E: insufficient_funds → user-friendly error → retry option.
- E2E: payment timeout (10 минут без webhook) → expired intent.
- Adversarial:
  - `[B1]` overbooking при race: два публичных пользователя одновременно бронируют последний номер.
  - `[B2]` webhook replay: тот же event_id → idempotent.
  - `[B3]` неверный HMAC → 401.
  - `[B4]` rate-limit на /availability/search.
  - `[B5]` SQL/XSS injection через guestContacts.
  - `[B6]` cross-tenant: nelzya создать intent через property другого tenant'а, если slug совпал.
  - `[B7]` cancellation flow → refund receipt.
  - `[B8]` partial refund (одна позиция чека).

### 4.B.8. Pre-done checklist (M8.B)

```
[ ] Ресерч-файлы yookassa.md, 54fz-fiscal.md, smartcaptcha.md, widget-best-practices.md созданы
[ ] CloudPayments: решение «один провайдер или два» зафиксировано
[ ] Public namespace /api/public/* изолирован от auth-required роутов
[ ] Rate-limit на каждом public endpoint
[ ] Captcha verify на критичных endpoint (booking-intent create)
[ ] HMAC verify на webhook
[ ] Idempotency через Idempotence-Key и event_id
[ ] 3DS-флоу работает (mock)
[ ] Fiscal receipt автоматически после succeeded payment
[ ] Refund receipt при cancel
[ ] axe-core green на ВСЕХ страницах виджета
[ ] Mobile-first проверен в Chrome DevTools mobile
[ ] Cross-tenant overbooking adversarial тест зелёный
[ ] Webhook replay idempotent
[ ] cross-tenant probe на public namespace
[ ] pnpm test:serial green
[ ] pnpm e2e:smoke green
[ ] Memory обновлена: добавить project_public_widget_done.md, project_yookassa_mock_done.md
```

---

## 4.C. Подфаза M8.C — Channel Manager (3 канала)

### 4.C.1. Какую боль закрывает

**Боль 2 — овербукинг + продажи**, функция 2.2.

Сценарий end-to-end:

1. Owner подключает каналы продаж (TravelLine, Я.Путешествия, Ostrovok) на странице «Каналы продаж».
2. Mapping: наши `room_type` ↔ их external_room_id.
3. Mapping: наши `rate_plan` ↔ их external_rate_id.
4. Push availability+rates → channels (cron каждые 5 минут).
5. Pull bookings ← channels (cron каждые 5 минут).
6. Конфликт обнаружен (overbooking из-за задержки sync) → reconciliation алерт + manual decision.
7. Cancellation на канале → pulled → reflected в нашей системе → refund flow.
8. Rate parity check: одинаковая цена везде, иначе предупреждение.

### 4.C.2. Внешние системы (ресерч-чек-лист)

**Файлы:** `plans/research/travelline-api.md`, `plans/research/yandex-travel-api.md`, `plans/research/ostrovok-api.md`, `plans/research/channel-manager-patterns.md`.

#### TravelLine, Я.Путешествия, Ostrovok — для каждого:

- Authentication (API key, OAuth, signed requests).
- Endpoints для push availability.
- Endpoints для push rates.
- Endpoints для pull bookings (last_modified-based polling).
- Cancellation events (webhook? polling?).
- Mapping: их `room_type_id` структура, `rate_plan_id` структура.
- Inventory model: per-room vs per-room-type, daily vs weekly grid.
- Rate model: BAR-flex, BAR-NR, special rates.
- Idempotency через external booking id.
- Rate-limits.
- Errors: invalid_room, invalid_rate, sold_out, conflict.
- Sandbox-окружение (если есть — проверим формат, не реальные ключи).

#### Channel Manager patterns

- Bnovo как делает.
- Cloudbeds Channel Manager.
- SiteMinder paradigm.
- TravelLine собственный CM (как они подходят).
- Conflict resolution policies.
- Rate parity tools.

### 4.C.3. Контракт мока

#### ChannelAdapter

```ts
interface ChannelAdapter {
  pushAvailability(input: AvailabilityPush): Promise<AvailabilityPushAck>
  pushRates(input: RatesPush): Promise<RatesPushAck>
  pullBookings(since: Date): Promise<ChannelBooking[]>
  pullCancellations(since: Date): Promise<ChannelCancellation[]>
  // mapping APIs
  listExternalRoomTypes(): Promise<ExternalRoomType[]>
  listExternalRatePlans(): Promise<ExternalRatePlan[]>
}
```

#### ChannelAdapterMockImpl (общий + per-channel customization)

- `pushAvailability`: ack через 100–800 мс. 3% — `409 conflict` (двойная отправка).
- `pushRates`: то же.
- `pullBookings`: возвращает 0–3 «новых» бронирований per call (синтетические с realistic данными).
- 1% — `503` retryable.
- Eventual consistency: pull сразу после push иногда не видит изменения.
- Каждый канал имеет свой namespace, чтобы тесты могли изолированно проверять логику per-channel.

### 4.C.4. Schema

Новая миграция `0024_channel_manager.sql`:

```
channel_config
  id (typeid prefix chcfg)
  tenantId
  propertyId
  channelKind (enum: travelline, yandex_travel, ostrovok)
  status (enum: disconnected, connecting, active, error, suspended)
  credentials (encrypted JSON: api_key, secret)
  lastSyncAt
  lastErrorReason
  PK (tenantId, id)
  Unique (propertyId, channelKind)

channel_room_mapping
  id, tenantId, configId
  internalRoomTypeId
  externalRoomTypeId, externalRoomTypeName
  inventoryAllocationPercent (0-100)

channel_rate_mapping
  id, tenantId, configId
  internalRatePlanId
  externalRatePlanId, externalRatePlanName
  priceModifierPercent (для каналов, требующих наценку)

channel_inventory_sync_log
  id, tenantId, configId
  syncedAt, durationMs
  recordsCount
  status (success, partial, failed)
  errorReason

channel_booking_pull_log
  id, tenantId, configId
  pulledAt, durationMs
  newBookings, updatedBookings, cancellations
  status, errorReason

channel_booking
  id, tenantId, configId
  externalBookingId (unique per channel)
  ourBookingId (FK после import)
  status (pending_import, imported, conflict, rejected)
  rawPayload (JSON)
  importedAt
```

### 4.C.5. Backend

- `domains/channel/`: factory + service + repo + routes + ChannelAdapter abstraction + 3 mock impl.
- `workers/channel-availability-push.cron.ts`: cron 5 минут.
- `workers/channel-rates-push.cron.ts`: cron 5 минут.
- `workers/channel-bookings-pull.cron.ts`: cron 5 минут.
- `workers/channel-conflict-reconciliation.ts`: при overbooking → активити + admin alert.
- Routes:
  - `GET /api/admin/channels` (list configs).
  - `POST /api/admin/channels/:id/connect` (создать config).
  - `POST /api/admin/channels/:id/test` (validate credentials, выполнить ping через mock).
  - `POST /api/admin/channels/:id/sync` (force manual sync).
  - `GET /api/admin/channels/:id/mappings` (room/rate mappings).
  - `PUT /api/admin/channels/:id/mappings` (update mappings).
  - `GET /api/admin/channels/:id/sync-log` (история синхронизаций).

### 4.C.6. Frontend

- `routes/_app.o.$orgSlug.admin.channels.tsx` — страница «Каналы продаж».
  - Список каналов со статусом, последняя синхронизация.
  - Connect wizard для каждого (mock запрашивает фейковый api_key).
  - Mapping UI: drag-mapping internal ↔ external.
  - Sync log таблица с фильтрами.
  - Error log + manual retry.
  - Rate parity view: таблица «наша цена vs цена на каналах», предупреждения.

### 4.C.7. Тесты

- Integration:
  - `[C1]` push availability → pull on same channel → видит изменения после eventual consistency window.
  - `[C2]` race: одновременная бронь с TravelLine и публичного виджета на тот же номер → conflict resolution → activity log + admin alert.
  - `[C3]` cancellation pull → import → existing booking → cancel → refund flow trigger.
  - `[C4]` mapping validation: nelzya сохранить mapping с несуществующим room_type.
  - `[C5]` cross-tenant × все endpoint.
  - `[C6]` RBAC: staff не видит channels page.
  - `[C7]` 503 retry на push availability.
  - `[C8]` мок повторил booking (тот же external_id) → idempotent.

### 4.C.8. Pre-done checklist (M8.C)

```
[ ] Ресерч-файлы 3 каналов + channel-manager-patterns.md созданы
[ ] Все 4 cron'а (availability, rates, bookings, conflict-reconciliation) работают
[ ] Conflict resolution alerts видны на admin-панели
[ ] Mapping UI работает для всех 3 каналов
[ ] Rate parity view работает
[ ] cross-tenant + RBAC × все методы
[ ] Adversarial overbooking тест с публичным виджетом + каналом зелёный
[ ] axe-core a11y на channels page
[ ] pnpm test:serial green
[ ] pnpm e2e:smoke green
[ ] Memory обновлена: project_channel_manager_done.md
```

---

## 4.D. Подфаза M8.D — KPI Domain + native UI + DataLens-готовность

### 4.D.1. Какую боль закрывает

**Боль 3 — слепое управление**, функция 3.1.

### 4.D.2. Решение (зафиксировано 2026-04-27)

**Вариант A.** KPI-домен (расчёт + эндпоинты + материализованные views) + native UI (страница «Аналитика» с тремя графиками: Occupancy, ADR, RevPAR + дополнительные). DataLens подключим параллельно в M9 к тем же данным. Функция 3.1 мандата закрыта end-to-end в нашем коде.

### 4.D.3. Канон KPI

Из [project_horeca_domain_model.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_horeca_domain_model.md):

- **Occupancy** = занятые номера / доступные номера × 100% (за день/период).
- **ADR** (Average Daily Rate) = revenue from occupied rooms / occupied rooms (за период).
- **RevPAR** (Revenue Per Available Room) = revenue / available rooms = Occupancy × ADR.
- Доп: TRevPAR (включая F&B), GOPPAR (gross operating profit), CPOR (cost per occupied room) — позже.

### 4.D.4. Schema

Миграция `0025_kpi_materialized.sql`:

```
kpi_occupancy_daily
  tenantId, propertyId, date
  totalRooms (snapshot), occupiedRooms, occupancyPercent
  computedAt
  PK (tenantId, propertyId, date)

kpi_revenue_daily
  tenantId, propertyId, date
  roomRevenue, addonRevenue, totalRevenue (всё в micros)
  occupiedRooms (для ADR)
  adrMicros, revparMicros
  computedAt
  PK (tenantId, propertyId, date)
```

### 4.D.5. Backend

- `workers/kpi-rollup.cron.ts`: cron каждый час (или daily-end), пересчитывает KPI за вчера + сегодня (running total).
- `domains/kpi/`: service + routes.
  - `GET /api/v1/kpi/occupancy?from=&to=&propertyId=&granularity=day|week|month`
  - `GET /api/v1/kpi/adr?...`
  - `GET /api/v1/kpi/revpar?...`
  - `GET /api/v1/kpi/summary?from=&to=` — все три + бонус (TRevPAR placeholder).

### 4.D.6. Frontend

- `routes/_app.o.$orgSlug.analytics.tsx` — страница «Аналитика».
  - Range picker (today, last 7d, last 30d, last quarter, custom).
  - Property filter (если несколько).
  - Три графика (Occupancy line, ADR bar, RevPAR line) — библиотека: recharts или visx (выбор после ресерча).
  - KPI cards с текущим значением + сравнение vs prev period.
  - Export to CSV/XLSX (используем write-excel-file).

### 4.D.7. Тесты

- Unit на расчётные формулы (property-based fast-check для математики).
- Integration: создать набор бронирований → запустить rollup → проверить exact values.
- Cross-tenant + RBAC.
- axe-core green.

### 4.D.8. Pre-done checklist (M8.D)

```
[ ] Решение по варианту A vs B зафиксировано
[ ] KPI-домен расчёт совпадает с каноном HoReCa (verified property-based)
[ ] Cross-property aggregation корректна
[ ] Edge cases: 0 available rooms, 0 occupied rooms, partial period
[ ] Native UI page работает с фильтрами
[ ] axe-core green
[ ] pnpm test:serial green
[ ] Memory обновлена: project_kpi_dashboard_done.md
```

---

## 4.E. Подфаза M8.E — Sandbox/Production gate + adapter factories + observability

### 4.E.1. Что делаем

Сквозные системные механизмы, которые должны быть на месте до перехода в M8.

### 4.E.2. APP_MODE flag

- Env-переменная `APP_MODE=sandbox|production` (default: sandbox).
- В `apps/backend/src/app.ts` startup-проверка:
  - В режиме `production` — итерируемся по всем factory и проверяем, что ни один не возвращает Mock-impl.
  - Если хоть один Mock — `process.exit(1)` с понятной ошибкой.
- В `apps/frontend/src/` — глобальный баннер «SANDBOX MODE» во всех режимах кроме production.
- Endpoint `/api/health/adapters` возвращает все adapter modes.

### 4.E.3. Adapter factories

Каждая интеграция — единая factory:

- `EpguAdapterFactory` (env-based: `EPGU_ADAPTER=mock|http`).
- `VisionAdapterFactory`.
- `RklAdapterFactory`.
- `PaymentAdapterFactory` (уже есть, расширим).
- `FiscalAdapterFactory`.
- `CaptchaAdapterFactory`.
- `ChannelAdapterFactory` (per-channel: `TRAVELLINE_ADAPTER`, `YANDEX_TRAVEL_ADAPTER`, `OSTROVOK_ADAPTER`).

Все factories соблюдают:

- В sandbox-режиме — возвращают Mock.
- В production-режиме — возвращают Http; если http не реализован → throw at startup.

### 4.E.4. Observability

- Tracing wraps каждого adapter call (span name, attributes: adapterName, method, durationMs, success).
- Логирование на info-level каждого adapter call с request-id correlation.
- Metrics: count + p99 per adapter method.
- Соблюдаем canon из [project_observability_stack.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_observability_stack.md): exporter no-op, code production-grade.

### 4.E.5. Тесты

- `[E1]` startup в production-mode при mock-adapter → exits с понятной ошибкой.
- `[E2]` startup в sandbox-mode с mock-adapter → ок.
- `[E3]` `/api/health/adapters` правдиво возвращает modes.
- `[E4]` SANDBOX banner виден во frontend.
- `[E5]` traces генерируются для каждого adapter call (проверка через no-op exporter с capture-режимом в тестах).

### 4.E.6. Pre-done checklist (M8.E)

```
[ ] APP_MODE флаг работает на startup
[ ] Все adapter factories унифицированы
[ ] /api/health/adapters реально показывает modes
[ ] SANDBOX banner во frontend
[ ] Tracing wraps на всех adapter calls
[ ] Все mock-adapter тесты проходят
[ ] pnpm test:serial green
[ ] pnpm build green
[ ] Memory обновлена: project_sandbox_gate.md
```

---

## 4.F. Подфаза M8.F — Документация интеграций + сидеры + видео-walkthroughs

### 4.F.1. Что делаем

Подготовка к плавному переключению в M8.

### 4.F.2. Документация adapter contracts

Для каждой интеграции — `docs/integrations/{name}.md`:

- Контракт интерфейса.
- Формат запросов и ответов.
- Список ошибок и поведенческие гарантии.
- Описание моков (что они имитируют, какие seed-параметры).
- Чек-лист «как переключить с mock на http» (что нужно: ключи, договоры, регистрации).
- Ссылки на ресерч-файлы.

### 4.F.3. Сидеры

`scripts/seed/` — набор сценариев:

- `seed-tenant.ts` — создаёт тестовый tenant с 1 property, 5 номерами, 3 rate plans.
- `seed-bookings.ts` — генерирует 50 бронирований в разных статусах (включая иностранцев).
- `seed-channels.ts` — настраивает 3 канала с маппингами.
- `seed-payments.ts` — создаёт платежи в разных статусах.
- `seed-all.ts` — full reset + всё вместе для демо-сценария.

### 4.F.4. Видео-walkthroughs

Через существующий [scripts/walkthrough/](../scripts/walkthrough/):

- `01-internal-booking.mp4` — заселение российского гостя.
- `02-foreign-booking.mp4` — заселение иностранца со сканом паспорта + МВД.
- `03-public-widget.mp4` — гость с улицы бронирует через виджет.
- `04-channel-manager.mp4` — настройка канала + конфликт + reconciliation.
- `05-analytics.mp4` — KPI дашборд.
- `06-tax-report.mp4` — тур.налог отчёт (уже есть, обновить).
- `07-notifications.mp4` — журнал уведомлений (уже есть, обновить).

### 4.F.5. README обновления

- Главный `README.md` — обновить секцию «Что закрыто» с актуальной картой.
- Каждая публичная страница — короткий help-блок «как пользоваться».

### 4.F.6. Pre-done checklist (M8.F)

```
[ ] Все adapter contracts задокументированы
[ ] Все ресерч-файлы присутствуют (М8.A,B,C,D)
[ ] Сидеры работают и идемпотентны
[ ] 7 видео записаны
[ ] README обновлён
```

---

## 4.G. Подфаза M8.G — Финальный кросс-функциональный аудит готовности к M8

### 4.G.1. Зачем

После всех подфаз (A–F) нужен общий audit-pass, чтобы убедиться, что система действительно production-grade и моки behaviour-faithful.

### 4.G.2. Чек-лист аудита

```
СКВОЗНЫЕ ПРОВЕРКИ
[ ] Cross-tenant probe: для каждого endpoint × каждый tenant × adversarial попытки
[ ] RBAC matrix: для каждого endpoint × каждой роли (owner/manager/staff) × каждый action
[ ] Enum coverage: каждый enum в schema проверен на все возможные значения в коде
[ ] Null vs undefined: patches с null vs undefined ведут себя различно (verified)
[ ] UNIQUE collisions: каждый unique index проверен adversarial-тестом
[ ] CDC + outbox: каждый событийный triggers корректно создаёт outbox-запись и обрабатывается
[ ] Activity log: каждый state-change на каждом domain отражён в activity
[ ] Idempotency: каждый «опасный» endpoint имеет idempotency key и проверен повторами
[ ] Rate-limit: каждый публичный endpoint защищён
[ ] Captcha: каждая публичная мутация защищена

СРАВНЕНИЕ С РЕАЛЬНОСТЬЮ
[ ] EpguMockImpl сверен с ресерчем (формат запросов, коды ошибок, тайминги)
[ ] VisionMockImpl сверен с ресерчем
[ ] RklMockImpl сверен
[ ] YooKassaMockImpl сверен
[ ] FiscalMockImpl сверен
[ ] CaptchaMockImpl сверен
[ ] TravelLineMockImpl сверен
[ ] YandexTravelMockImpl сверен
[ ] OstrovokMockImpl сверен

ИНФРАСТРУКТУРНЫЕ ПРОВЕРКИ
[ ] APP_MODE=production → отказывает при mock-adapters
[ ] APP_MODE=sandbox → все работает
[ ] /api/health/adapters truthful
[ ] SANDBOX banner виден
[ ] Tracing работает
[ ] Все cron'ы работают и не дублируют work

ТЕСТОВАЯ ИНФРАСТРУКТУРА
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
[ ] pnpm e2e:smoke: 100% green (включая axe a11y gate)

DOMAIN-ЦЕЛОСТНОСТЬ
[ ] Все 6 функций мандата (1.1, 1.2, 2.1, 2.2, 2.3, 3.2) + 3.1 (Вариант A) закрыты end-to-end
[ ] Туристический налог 2% закрыт (бонус)
[ ] Все 3 боли мандата закрыты в локальной системе

DEPENDENCY FRESHNESS (final)
[ ] npm-registry аудит всех deps на latest stable
[ ] Deprecated → заменены
[ ] Docker images → latest stable
[ ] Memory project_locked_versions.md обновлён

ПОДГОТОВКА К M8
[ ] docs/integrations/* полные
[ ] Сидеры работают
[ ] Видео записаны
[ ] План M8 (реальные интеграции) можно начать без догоняющих работ
```

### 4.G.3. Финальный артефакт

После прохождения G — обновляется [project_initial_framing.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_initial_framing.md) с актуальной таблицей: 6 функций closed end-to-end (или 7 при варианте A), 3 боли closed.

---

## 5. Сквозные принципы и инфраструктурные элементы

### 5.1. Test partitioning

К существующим test:serial / test и test:unit добавляем:

- `test:integrations` — только integration-тесты (адаптеры, воркеры, CDC).
- `test:e2e` — только playwright.
- `test:adversarial` — only теги adversarial.
- В pre-push gate — оставляем `test:serial` (всё) как сейчас.

### 5.2. Feature flags для каждой интеграции

В `apps/backend/src/config.ts` (или env) — explicit feature flags:

- `FEATURE_EPGU_ENABLED`
- `FEATURE_PASSPORT_OCR_ENABLED`
- `FEATURE_RKL_ENABLED`
- `FEATURE_PUBLIC_WIDGET_ENABLED`
- `FEATURE_CHANNEL_MANAGER_ENABLED`
- `FEATURE_KPI_ENABLED`

Default — все `true` в локалке. Pre-prod — selective.

### 5.3. Migration policy

- Каждая подфаза — свой набор миграций (0021–0025+).
- Backfill scripts — отдельный файл, идемпотентны, тестируются.
- Rollback не требуется (по канону YDB и нашей политики), но миграции — additive only.

### 5.4. Activity log canon

Расширяем `objectType` enum в [packages/shared/src/activity.ts](../packages/shared/src/activity.ts):

- `migration_registration`, `passport_scan`, `rkl_check`, `public_booking`, `channel_config`, `channel_booking`, `kpi_rollup`.

И `activityType`:

- `submitted`, `confirmed`, `rejected`, `permanent_failed`, `manuallyResubmitted`.
- `scanned`, `consented`.
- `rklChecked`, `rklMatch`.
- `webhookReceived`, `paymentSucceeded`, `paymentFailed`, `refunded`.
- `channelConnected`, `channelSynced`, `channelConflict`.
- `kpiRolledUp`.

### 5.5. CDC consumers и event architecture

Канон [project_event_architecture.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_event_architecture.md): CDC-first outbox + polymorphic activity. Для всех новых domain — то же.

### 5.6. Локализация и i18n

В соответствии с project canon: hardcoded RU strings. Lingui v6 в репо есть, но мы пока не активируем — single-locale.

### 5.7. Безопасность

- 152-ФЗ: согласие гостя на обработку (модальное окно при первом OCR), retention policy, шифрование at rest для credentials и фото паспортов.
- 54-ФЗ: фискализация всех успешных платежей.
- Public widget: rate-limit, captcha, HMAC, no-XSS, no-SQL-injection (zod валидация).

### 5.8. A11y

axe-core gate на ВСЕХ новых страницах (existing canon: [project_axe_a11y_gate.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_axe_a11y_gate.md)).

### 5.9. APG grid canonical

Если на admin-страницах будут таблицы с колоночными bands — соблюдаем [project_apg_grid_canonical.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_apg_grid_canonical.md): `aria-colspan` + `grid-column: span N` в DOM flow, никаких absolute overlays.

### 5.10. CORS allow-list

[feedback_cors_custom_headers.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/feedback_cors_custom_headers.md): новые headers → backend `cors().allowHeaders` в том же коммите.

---

## 6. Решения (зафиксированы 2026-04-27)

| # | Вопрос | Решение |
|---|---|---|
| Q1 | KPI dashboard: вариант A или B? | **A** — KPI-домен + native UI + DataLens-готовность |
| Q2 | Channel Manager: 3 канала сразу или пошагово? | **3 сразу** — TravelLine + Я.Путешествия + Ostrovok |
| Q3 | Public widget: отдельный SPA или роуты в основном frontend? | **Роуты в существующем frontend** |
| Q4 | YooKassa vs CloudPayments: один или два? | **Только YooKassa** (фабрика готова к расширению) |
| Q5 | MCP-сервер: в M8.A–G или позже? | **M9** — после реальных интеграций |
| Q6 | Сидеры: интерактивный CLI или фиксированные команды? | **Фиксированные команды** (`pnpm seed:*`) |
| Q7 | Custom Object Engine: отложен в M11+? | **Отложен в M11+** |

---

## 7. Что НЕ входит в эту фазу (отложено на M8/M9/M10/M11+)

- **Реальные внешние интеграции** — это и есть M8 после прохождения текущей фазы.
- **Деплой**: SourceCraft, Terraform, Yandex Cloud setup — M9+. См. [project_deferred_deploy_plan.md](/Users/ed/.claude/projects/-Users-ed-dev-sochi/memory/project_deferred_deploy_plan.md).
- **PWA / offline support** — M9+.
- **Yandex Monium активация** (production tracing exporter) — M9+.
- **Yandex DataLens setup** — M9+ (но KPI-домен делаем сейчас, чтобы DataLens мгновенно подключился).
- **MCP-сервер** — M9 (см. Q5).
- **Custom Object Engine** — M11+ (см. Q7).
- **Booking.com / Expedia / Airbnb** — phase 2-3 после первых клиентов.
- **F&B, SPA, ski-school multi-vertical** — после первого pivot.

---

## 8. Риски и mitigations

| Риск | Вероятность | Воздействие | Mitigation |
|---|---|---|---|
| Мок недостаточно реалистичен → реальная интеграция ломает обвязку | Средняя | Высокое | Ресерч-файл обязателен ДО мока. Behaviour-faithful требования (§2.1). Sверка на M8.G аудите. |
| Sandbox-режим случайно уехал в продакшн | Низкая | Критично | APP_MODE=production отказывает при mock (§4.E.2). Banner в UI. health-endpoint. |
| Скоп Channel Manager (M8.C) растягивается | Высокая | Высокое | Жёсткий time-cap 4 недели. Если не успеваем — урезать до 1 канала (TravelLine), 2 канала переносим в M8.C.2 |
| Public widget overbooking race с CM | Средняя | Высокое | Adversarial тесты [B1] + [C2]. Atomic locking уже есть в booking domain |
| 152-ФЗ нарушения через хранение фото | Низкая | Критично (юр) | TTL на Object Storage. Retention policy. Шифрование at rest. Согласие отдельно от ToS. |
| Mock OCR даёт false positives → реальная регистрация в МВД с ошибочными данными | Низкая (это всё же sandbox) | Среднее | Confidence-флаги обязательны на каждом поле. Manual confirmation step перед submit. |
| Время до выручки растягивается | Высокая | Высокое (для бизнеса) | Открытое обсуждение с пользователем. План корректируется при необходимости. |
| Зависимости устаревают за 10–13 недель | Высокая | Среднее | npm-registry аудит после каждой подфазы (§2.7). |
| Pre-push gate деградирует от объёма | Средняя | Среднее | Test partitioning (§5.1). Если test:serial > 5 минут — рассматриваем split. |

---

## 9. Что я ОБЯЗАН помнить на всех этапах

- Я единственный ответственный. Senior + lead + product в одном лице.
- Не торопиться. Пользователь явно просил «не торопиться, делать тщательно, при сомнениях — спрашивать».
- Empirical method на каждом шаге. Не верить памяти модели.
- При обнаружении противоречий между планом и реальностью — править план, не хакать вокруг.
- При появлении новых learning'ов — обновлять memory.
- Ни одна подфаза не закрывается без pre-done audit gate.
- Strict tests, не подстраивающиеся под код.
- Production-grade с первой строчки.
- Aggressive de-legacy + dependency freshness.
- Automate every check.

---

## 10. Что делаем прямо сейчас

1. Пользователь читает этот план.
2. Отвечает на 7 открытых вопросов §6.
3. Утверждает план или предлагает корректировки.
4. После утверждения — стартую с **M8.A** (ЕПГУ + Vision + RKL).
5. Первый шаг M8.A — три ресерч-файла (`plans/research/epgu.md`, `yandex-vision-passport.md`, `rkl.md`). Без них код не пишется.
6. После ресерча и подтверждения покрытия пользователем — schema → backend → frontend → тесты.
