# Research: YooKassa + 54-ФЗ + СБП + 3DS + Recurring

**Дата:** 2026-04-27
**Источник:** research-агент волны 1
**Confidence:** High (endpoints, payment object, webhooks security, 54-ФЗ tags), Medium (точные latency webhook retry, CloudPayments comparison)

---

## 1. YooKassa API 2026

### 1.1 Base + Auth

| Параметр | Значение |
|---|---|
| Base URL | `https://api.yookassa.ru/v3/` |
| Протокол | HTTPS only, TLS 1.2+ |
| Auth | HTTP Basic — username = `shopId`, password = `secretKey`. Альтернатива OAuth 2.0 только для партнёрской программы |
| Content | `Content-Type: application/json` для POST/DELETE |
| Тестовый режим | Отдельные test `shopId` + `secretKey`. Все объекты помечены `test: true`. Money не двигается |

### 1.2 Endpoints

```
POST   /v3/payments                          create
GET    /v3/payments/{id}                     get
GET    /v3/payments?limit=…&cursor=…         list (cursor-based)
POST   /v3/payments/{id}/capture             capture (partial via amount)
POST   /v3/payments/{id}/cancel              cancel (только waiting_for_capture)

POST   /v3/refunds                           create
GET    /v3/refunds/{id}                      get
GET    /v3/refunds?payment_id=…              list

POST   /v3/receipts                          create (delayed-fiscal flow)
GET    /v3/receipts/{id}
GET    /v3/receipts?payment_id=…|refund_id=…

POST   /v3/payouts                           выплаты
POST   /v3/deals                             split / safe-deal
POST   /v3/webhooks                          программная регистрация
GET    /v3/me                                shop info; в 2026 включает fiscalization.provider = 'yoo_receipt'
```

### 1.3 Idempotence-Key — формат и scope

- **Header name:** `Idempotence-Key` (не Idempotency).
- **Format:** любая уникальная строка ≤ **64 символов**. Документация рекомендует UUID v4.
- **Required:** для всех POST и DELETE.
- **Scope:** per shopId. Коллизия в течение **24 часов** ⇒ duplicate, возвращается ранее созданный объект.
- **Поведение:** тот же ключ + тот же body ⇒ кэш. Тот же ключ + другой body ⇒ ошибка. Другой ключ + тот же body ⇒ новый объект (риск дубликата — за нами).

### 1.4 Payment object

```jsonc
// POST /v3/payments request
{
  "amount": { "value": "1500.00", "currency": "RUB" },
  "capture": true,                                       // false ⇒ two-stage
  "confirmation": {
    "type": "redirect",                                  // redirect | embedded | external | mobile_application | qr
    "return_url": "https://hotel.example/booking/return"
  },
  "description": "Бронь №B-2026-04-27-001",             // ≤128 chars
  "payment_method_data": { "type": "bank_card" },        // bank_card | sbp | sberbank | tinkoff_bank | yoo_money | sber_pay | t_pay | mir_pay
  "save_payment_method": false,
  "metadata": { "bookingId": "bkg_…", "tenantId": "tnt_…" },
  "merchant_customer_id": "guest_…",
  "receipt": { /* см. п. 4 */ }
}

// response
{
  "id": "2c…",
  "status": "pending",
  "paid": false,
  "amount": { "value": "1500.00", "currency": "RUB" },
  "income_amount": { "value": "1452.00", "currency": "RUB" },  // после комиссии и НДС с комиссии (2026!)
  "expires_at": "2026-04-27T22:00:00.000+03:00",         // hold expiry для two-stage
  "confirmation": { "type": "redirect", "confirmation_url": "..." },
  "test": false,
  "refunded_amount": { "value": "0.00", "currency": "RUB" },
  "refundable": false,
  "receipt_registration": "pending",                      // pending|succeeded|canceled
  "metadata": { /* … */ },
  "cancellation_details": null
}
```

### 1.5 Webhook events — полный список (8)

| Event | Когда | Группа |
|---|---|---|
| `payment.waiting_for_capture` | Two-stage авторизация прошла, ждём capture | payment |
| `payment.succeeded` | Деньги списаны | payment |
| `payment.canceled` | Платёж отменён | payment |
| `refund.succeeded` | Возврат завершён | refund |
| `payout.succeeded` | Выплата завершена | payouts |
| `payout.canceled` | Выплата отменена | payouts |
| `deal.closed` | Safe-deal закрыт | platforms |
| `payment_method.active` | Сохранённый метод активирован | recurring |

**ВАЖНО:**
- **Нет `refund.canceled` event.** При canceled refund узнаём через GET `/v3/refunds/{id}`.
- **Нет `payment.pending`.** Создание = синхронный POST, ответ сразу содержит `pending`.

### 1.6 Webhook delivery

- **Retry:** «доставлять в течение **24 часов**» при отсутствии HTTP 200. Точное расписание ретраев (exponential backoff) **не раскрыто публично**.
- **HTTP code:** только `200` подтверждает доставку.
- **⚠️ HMAC ОТСУТСТВУЕТ.** ЮKassa не подписывает payload. Вместо подписи документация рекомендует:
  1. **IP allowlist** — мандатно.
  2. **Status verification** — GET `/v3/payments/{id}` после получения webhook; trust только тому, что вернёт API.
- **IP ranges (2026-04):**
  ```
  185.71.76.0/27
  185.71.77.0/27
  77.75.153.0/25
  77.75.154.128/25
  77.75.156.11/32
  77.75.156.35/32
  2a02:5180::/32
  ```
- **TLS:** 1.2+ обязательно.

**Подтверждение нашего канона:** synthDedupKey `${providerPaymentId}|${event}|${status}|${amount_value}` — корректное обходное решение.

### 1.7 3DS flow в 2026

Документация описывает **4 confirmation types**:

1. **`redirect`** — самый частый. `confirmation.confirmation_url` → 302 → банк проводит 3DS challenge → возврат на наш `return_url`. **Основной поток в 2026.**
2. **`embedded`** — checkout.js widget, 3DS внутри iframe.
3. **`external`** — пользователь подтверждает «вне» (SMS-bank, push).
4. **`mobile_application`** — deep-link.

**API-driven 3DS (CRES/CReq стрингами через REST) у ЮKassa НЕ предлагается публично.** Для виджета бронирования отеля — `redirect` правильный выбор.

### 1.8 Two-stage (authorization vs charge)

- `capture: false` ⇒ статус = `waiting_for_capture`. Field `expires_at` = дедлайн capture. **Hold window зависит от метода**: «от 2 часов до 7 дней».
- `POST /payments/{id}/capture` с пустым body = full capture. С `amount` = partial capture.
- `POST /payments/{id}/cancel` работает **только в `waiting_for_capture`**. После `succeeded` — только refund.
- Если merchant не делает capture в окне ⇒ авто-cancel с `cancellation_details.reason = expired_on_capture`.

### 1.9 Cancellation reasons (полный список)

| reason | retryable | смысл |
|---|---|---|
| `3d_secure_failed` | yes | гость не прошёл 3DS |
| `call_issuer` | yes | банк-эмитент отказал |
| `canceled_by_merchant` | no | мы сами отменили |
| `card_expired` | yes | срок карты |
| `country_forbidden` | yes | blocked country |
| `deal_expired` | no | safe-deal истёк |
| `expired_on_capture` | yes | мы не сделали capture |
| `expired_on_confirmation` | yes | гость не подтвердил |
| `fraud_suspected` | yes | антифрод |
| `general_decline` | yes | без специфики |
| `identification_required` | yes | YooMoney wallet ID |
| `insufficient_funds` | yes | мало денег |
| `internal_timeout` | yes | таймаут 30s — ретрай |
| `invalid_card_number` | yes | опечатка |
| `invalid_csc` | yes | CVV2 неверен |
| `issuer_unavailable` | yes | банк недоступен |
| `payment_method_limit_exceeded` | yes | лимит |
| `payment_method_restricted` | yes | блокировка/sanctions |
| `permission_revoked` | no | recurring отозван |
| `unsupported_mobile_operator` | yes | для оплаты «с мобильного» |

`cancellation_details.party`: `merchant` | `yoo_money` | `payment_network`.

### 1.10 Тестовые карты sandbox

**Успешный happy path:**

| PAN | Сеть | 3DS |
|---|---|---|
| 5555555555554477 | Mastercard | да |
| 5555555555554444 | Mastercard | нет |
| 4793128161644804 | Visa | да |
| 4111111111111111 | Visa | нет |
| 2200000000000004 | Mir | да |
| 2202474301322987 | Mir | нет |
| 370000000000002 | AmEx | нет |

**Decline-сценарии:** специальные PAN, симулирующие конкретный `cancellation_details.reason` (insufficient_funds, 3d_secure_failed, card_expired, fraud_suspected, и т.д.).

Любой CVV/срок проходит для test PAN.

### 1.11 Settlement timing

- **T+1** для РФ-резидентов: «не позднее **второго рабочего дня**».
- Из суммы выплаты вычитаются: комиссия + НДС с комиссии (новое в 2026!) + refunds того же расчётного дня.
- Минимальной суммы выплаты — нет.
- T+0 / instant settlement публично **не предлагается**.

### 1.12 Изменения 2026 (changelog)

- **01.01.2026:** НДС 20% → 22%. Новые `vat_code` 11 (22%) и 12 (22/122).
- **01.01.2026:** комиссия включает НДС 22% с самой комиссии.
- **23.04.2026:** «Плати частями» max single payment 50 000 ₽ (было 150 000), только 2-month rate.
- **21.04.2026:** `Me` объект расширен `fiscalization.provider = 'yoo_receipt'`.
- **07.04.2026:** payouts получили `payout_destination.sbp_operation_id`.
- **13.04.2026:** widget показывает success page после оплаты.

---

## 2. СБП через YooKassa

### 2.1 Подключение

- В payment_method_data: `"type": "sbp"`. Никаких доп. полей не нужно.
- `confirmation.type = "redirect"` (других вариантов для СБП нет).
- `capture: true` **обязательно** — двухстадийки СБП через ЮKassa нет.
- Минимум 1 ₽, **максимум 700 000 ₽** (повышение через manager). Срок оплаты — **1 час**.

### 2.2 UX flow

- **Desktop:** QR-код. Гость сканирует камерой банк-приложения.
- **Mobile (тот же телефон):** список банков; tap → deep-link в приложение → возврат на `return_url`.
- **Response поля:**
  - `payment_method.payer_bank_details.bic` (БИК банка плательщика)
  - `payment_method.payer_bank_details.bank_id` (НСПК bankId)
  - `payment_method.sbp_operation_id` — transactionId в НСПК

### 2.3 Webhooks для СБП

Те же события, что для card: `payment.succeeded` | `payment.canceled`. **Отдельных webhook events для СБП нет.**

### 2.4 Возвраты СБП

- Полные и частичные refunds поддерживаются.
- Срок зачисления гостю: «**на следующий день**».
- Refund object содержит `sbp_operation_id` для трассируемости.

### 2.5 Recurring через СБП

- `save_payment_method: true` поддерживается, но **не все банки СБП participants** реализуют recurring. ЮKassa фильтрует список банков на shortlist supporters → потенциально хуже UX, чем через card.

---

## 3. Рекуррентные платежи

### 3.1 Setup-flow

1. **Первый платёж:** POST с `save_payment_method: true`. После `succeeded` ⇒ `payment_method.id` (хранить).
2. **Charge без участия:** POST `/v3/payments` с `payment_method_id: <saved>` (без `payment_method_data`). Документация: «безакцептное списание» — без 3DS, без подтверждения.
3. ЮKassa **не имеет понятия subscription**. Periodicity — на нашей стороне (cron). Отзыв согласия = `cancellation_details.reason = permission_revoked`.

### 3.2 Применимость

- ✅ Tips / room service post-stay.
- Deposit hold — через **two-stage** (`capture: false`), не через recurring.
- ✅ Auto-charge no-show fee.
- Subscription billing самого SaaS Sochi — возможно лучше через CloudPayments.

### 3.3 Hold для recurring

«Hold flows» документация **прямо не описывает** для recurring. Нельзя сделать «pre-auth saved method T+72h» — либо single-shot charge, либо новый two-stage payment с тем же `payment_method_id`.

---

## 4. 54-ФЗ + ОФД фискализация

### 4.1 Когда чек должен быть отправлен

54-ФЗ требует чек **в момент расчёта**. Для онлайн-платежей = подтверждение оплаты (`payment.succeeded`). Чек должен быть зарегистрирован у ОФД и отправлен покупателю на email/SMS в течение секунд после succeeded.

С 01.09.2025 для всех онлайн-расчётов **обязателен tag 1008 (email или phone)** — без него ОФД отклонит чек.

### 4.2 Обязательные tags (FFD 1.2)

| tag | name | значение для отеля |
|---|---|---|
| 1054 | признак расчёта | 1=приход, 2=возврат, 3=коррекция прихода, 4=коррекция возврата |
| 1055 | признак системы налогообложения | 1=ОСН, 2=УСН доход, 3=УСН доход-расход, 4=ЕСХН, 5=ПСН, 6=НПД |
| 1059 | предмет расчёта (line item) | массив объектов |
| 1199 | ставка НДС | для accommodation = **5 (НДС 0%)** до 31.12.2030; для остального в 2026 = **11 (НДС 22%)** |
| 1212 | признак предмета расчёта | **4 = услуга** для проживания |
| 1214 | признак способа расчёта | 1=полный расчёт, 2=аванс с известным предметом, ... |
| 1008 | email/phone | **обязательно** для онлайн-чеков с 09.2025 |
| 2108 | единица измерения | **новое в ФФД 1.2** — `day` для проживания, `another` для services |

### 4.3 ⚠️ Расхождение с нашим каноном

Наш canon `tag1199 = literal(5)` слишком жёсткий. **Корректно:**
- Receipt-уровень `tag1199 ∈ {5, 6, 11, 12}` (0% / без НДС / 22% / 22-122).
- Per-line `vat_code` 1..12 — каждая строка может иметь свой.

**Действие:** в Phase 3 обновить Zod-схему receipt.

### 4.4 ЮKassa Чеки — embedded fiscalization

**Как работает:** к payment-запросу добавляется `receipt` объект. ЮKassa сама регистрирует чек в **Первом ОФД** и отправляет email клиенту.

**Структура `receipt`:**
```jsonc
{
  "customer": {
    "full_name": "Иванов Иван Иванович",
    "email": "guest@example.com",
    "phone": "+79991234567"
  },
  "items": [
    {
      "description": "Проживание, номер Standard, 27.04.2026 - 30.04.2026",
      "quantity": "3.00",                  // 3 ночи
      "amount": { "value": "4500.00", "currency": "RUB" },
      "vat_code": 5,                       // НДС 0% accommodation
      "payment_subject": "service",
      "payment_mode": "full_payment",
      "measure": "day"                     // ФФД 1.2 tag 2108
    },
    {
      "description": "Завтрак",
      "quantity": "3.00",
      "amount": { "value": "900.00", "currency": "RUB" },
      "vat_code": 11,                      // НДС 22%
      "payment_subject": "service",
      "payment_mode": "full_payment",
      "measure": "piece"
    }
  ],
  "tax_system_code": 1,                    // ОСН
  "send_at": "2026-04-27T10:00:30+03:00"
}
```

**Refund чек:** при `/v3/refunds` передаётся аналогичный `receipt` с `tag1054 = 2`. ЮKassa автоматически формирует refund-чек.

**Ограничения ЮKassa Чеки:**
- Только email-доставка чека (SMS не поддерживается).
- **Не делает correction-чеки** (для этого — внешний фискализатор).
- ОФД фиксирован — Первый ОФД.

**Стоимость:** на 2026 — Чеки от ЮKassa **не имеют отдельного abon-fee**, входят в базовую комиссию (2.8% + 1% receipt service). ⚠️ Наш canon-цифра 0.8-1.2% устарела.

**Промо-оферта** (28.01.2026 — 01.12.2026): пониженная комиссия для **новых** контрагентов при подключении Чеков. Релевантно нашему первому клиенту.

### 4.5 Внешний фискализатор vs ЮKassa Чеки — рекомендация

| критерий | ЮKassa Чеки | АТОЛ Онлайн / OFD.ru / ОФД-Я |
|---|---|---|
| setup time | минуты | 1-3 дня |
| ОФД | фиксирован Первый ОФД | свободный выбор |
| абон.плата | нет (входит в acquiring fee) | АТОЛ ~1733 ₽/мес/касса; OFD.ru ~3000/год |
| **correction чек** | **нет — критично** если будут ошибки | да, полный набор (ФФД 1.2) |
| API-связность | один API | отдельные адаптеры |
| 152-ФЗ | данные у ЮKassa+1ОФД | данные у acquirer + ОФД |
| масштаб | до ~300-400К ₽/мес ROI лучше | свыше — ROI flips |

**Для V1 / small hotel в Сочи:** **ЮKassa Чеки.** Architectural seam в `PaymentProvider.capabilities.fiscalization: 'native'|'external'|'none'` уже зарезервирован.

**Когда переходить на внешний:** первый случай correction-чека, или оборот >400К ₽/мес.

### 4.6 Признак агента для отеля

Отель оказывает услуги **сам** ⇒ **не агент**. `agent_type` НЕ передаётся.

Агентский режим включается, если:
- отель собирает плату за услуги OTA (мы — agent, OTA — поставщик).
- отель собирает плату за услуги SPA, экскурсии от внешнего ИП.

Для V1 (single-property, direct booking only) `agent_type` не нужен.

### 4.7 Электронный vs бумажный

54-ФЗ для онлайн-расчётов: **только электронный** чек (email/SMS). Бумажный не требуется. Если гость платит на стойке наличными/картой через POS — нужна локальная ККТ + бумажный чек.

### 4.8 Туристический налог 2% (Сочи) в чеке

**В чеке отдельной строкой НЕ выделяется** (НК РФ + позиция Минфина 04.10.2024 № 03-05-08/96119).

- На чеке одна строка `accommodation` со ставкой `vat_code: 5` (0%) на полную сумму проживания (с уже включённым tour tax).
- Tour tax учитывается отдельно в нашем folio (категория `tourismTax` в folioLine), но для receipt — **не выделяется**.
- На счёте/инвойсе — можно (и стоит) показать как отдельную строку.

**Ловушка:** база туристического налога **не включает** сам туристический налог (НК РФ ст. 418.7). Наш canon `max(base * bps / 10000, 100_minor * nights)` — корректен.

### 4.9 НДС 22% для отелей в 2026

- **Базовая ставка:** 22%.
- **Льгота 0% для accommodation services:** продлена до **31.12.2030**, только для accommodation в реестре классифицированных средств размещения (ОКВЭД 55.1, 55.2). Сочи — Сириус и Адлер.
- **Дополнительные услуги** (F&B, SPA, parking, transfers): **22%**.
- **Порог НДС-плательщика:** 2026 → доход >20 млн ₽/год; 2027 → 15 млн; 2028 → 10 млн.
- Малый отель на УСН без НДС → `vat_code строки = 6` (без НДС), льгота 0% **не применима** (это ставка для НДС-плательщиков).

---

## 5. CloudPayments как альтернатива

| критерий | YooKassa | CloudPayments |
|---|---|---|
| owner | YooMoney | Tinkoff Group |
| webhook signature | **отсутствует HMAC**, IP+poll | **HMAC-SHA256** (`X-Content-HMAC`) |
| recurring API | сохранённый payment_method_id | **полноценная Subscriptions API** |
| 54-ФЗ embedded | Чеки от ЮKassa (Первый ОФД) | CloudKassir (Атол) |
| 3DS | redirect-only | redirect + Charge API (3DS hosted form) |
| тарифы | 2.8% + 1% receipt | от 1.7% карты, 0.8% СБП |

**CloudPayments сильнее:**
- HMAC подпись webhooks.
- Subscription API нативная — для подписочной части нашего SaaS.
- Чарджи через JS SDK без redirect.

**CloudPayments слабее:**
- Embedded fiscalization сложнее (через CloudKassir + Атол).
- РФ сильное смещение к Tinkoff acquiring.
- Документация менее детальна по edge cases.

**Можно ли позже добавить provider:** **да**. Наш `PaymentProvider` интерфейс полиморфный. Адаптер `CloudPaymentsProvider` ляжет рядом со `YooKassaProvider` и `StubProvider`.

**Рекомендация:** ЮKassa primary V1 (как канон). CloudPayments — рассматривать для **subscription billing самого SaaS** (multi-tenant отели платят нам). Это разные business surfaces.

---

## 6. Туристический налог 2% (Сочи) в чеке

См. 4.8. Кратко:

- **В чеке отдельной строкой не выделяется.**
- vat_code: 5 (0% льгота) или 6 (без НДС).
- На счёте/инвойсе — можно показать как отдельную строку.
- TravelLine, Bnovo делают так же.

---

## 7. Решения для нашего mock-адаптера

### 7.1 YooKassaMockImpl behaviour

1. **Idempotence-Key обязателен** на POST/DELETE; коллизия = duplicate response.
2. **createPayment** возвращает `confirmation_url` с mock-страницей 3DS.
3. **3DS challenge** — 30% запросов требуют 3DS, mock-страница «Подтвердите оплату».
4. **Webhook через 2-10 секунд** после createPayment (mock dispatcher с timer + jitter).
5. **`payment.succeeded`** в 90% случаев.
6. **Decline вероятности:**
   - 5% — `payment.canceled` (insufficient_funds).
   - 2% — `3ds_authentication_failed`.
   - 1% — `fraud_suspected`.
   - 1% — `internal_timeout`.
   - 1% — `card_expired`.
7. **Idempotence:** повторный createPayment с тем же Idempotence-Key → возврат существующего платежа.
8. **Receipt:** после succeeded — fiscal receipt mock через 5-30 секунд (`receipt_registration: 'pending' → 'succeeded'`).
9. **Refund:** synchronous, но fiscal refund-receipt с задержкой до 60 секунд.
10. **No HMAC** — наш webhook receiver доверяет IP allowlist + дополнительно делает GET `/v3/payments/{id}` для verification.
11. **Income amount** = `amount * (1 - 0.038)` (имитация 2.8% + 1% commission VAT 22%).

### 7.2 Тестовые карты

Hardcoded набор PAN с deterministic outcomes по hash:
- Successful happy: `4111111111111111`, `5555555555554444`, `2202474301322987`.
- 3DS happy: `4793128161644804`, `2200000000000004`.
- Decline scenarios: `4000000000000002` → insufficient_funds, `4000000000000093` → 3ds_authentication_failed, и т.д.

### 7.3 FiscalAdapterMockImpl

- Ack через 200-800 мс.
- Fiscal Document Number 16-digit realistic.
- 3% — `503 ofd_unavailable` (retry).
- 1% — `422 invalid_taxation_system`.

### 7.4 СБП Mock

- `payment_method_data.type: sbp` → `confirmation_url` с QR (mock).
- `capture: false` → 400 (не поддерживается).
- Webhook через 2-15 секунд.
- 2% — `cancellation_details.reason: expired_on_confirmation` (гость не подтвердил в 1 час).

---

## 8. Открытые вопросы

1. YooKassa точная экспоненциальная задержка retry webhook (24h envelope, точные интервалы непублично).
2. YooKassa TLS-cert pinning — валидируют ли webhooks specific certificate fingerprint.
3. `payment_method_data.type` — полный список 2026 (мажорно подтверждены 8: bank_card, sbp, sberbank, tinkoff_bank, yoo_money, sber_pay, t_pay, mir_pay).
4. СБП recurring — какие банки-participants поддерживают.
5. SBP individual rate negotiation — где порог.
6. **Accommodation vat_code 5 vs 6** на УСН без НДС — нужна decision-tree в коде.
7. Чеки от ЮKassa — действительно ли «0 abon» или скрытый «receipt service fee» в выписке.
8. Correction-чек цепочка ≤3 — правовое обоснование (точная ссылка на письмо ФНС).
9. `measure: "day"` vs `"another"` для проживания — официальная позиция ФНС не до конца ясна.
10. `tag1212 = 4` (услуга) vs `7` (агентское вознаграждение) для commission flow OTA.

---

## 9. Что обновить в нашем canon

Правки в `project_payment_domain_canonical.md`:

1. **Webhook IP refresh frequency**: убрать «refresh daily» (canon ошибка), заменить на «monitor docs page; no published cadence».
2. **Чеки от ЮKassa pricing**: «+0.8-1.2% surcharge» → «no separate abon-fee, входит в base 2.8% + 1% receipt service fee structure (2026)».
3. **vat_code на receipt-уровне**: текущая Zod `tag1199 = literal(5)` слишком жёсткая. Корректнее: `tag1199 ∈ {5, 6, 11, 12}` + per-line `vat_code` 1..12.
4. **СБП recurring caveat**: добавить «не все банки СБП поддерживают recurring».
5. **`refund.canceled` event отсутствует**: явно зафиксировать, что failure detection — через poll.
6. **Settlement T+1**: добавить (для UI / treasury logic).
7. **2026-01-01 НДС 22% commission VAT**: учесть в `verifyWebhook` snapshot для income_amount parsing.
8. **Промо-оферта 28.01-01.12.2026**: первый клиент должен попасть в окно для пониженной комиссии.

---

## 10. Источники (URL + дата 27.04.2026)

**YooKassa официальные:**
- [API root](https://yookassa.ru/developers/api)
- [Idempotence-Key](https://yookassa.ru/developers/using-api/interaction-format)
- [Webhooks](https://yookassa.ru/developers/using-api/webhooks)
- [Payment process](https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process)
- [Declined payments / cancellation reasons](https://yookassa.ru/developers/payment-acceptance/after-the-payment/declined-payments)
- [Refunds](https://yookassa.ru/developers/payment-acceptance/after-the-payment/refunds)
- [SBP integration](https://yookassa.ru/developers/payment-acceptance/integration-scenarios/manual-integration/other/sbp)
- [Recurring with saved method](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved)
- [Чеки от ЮKassa basics](https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/basics)
- [Receipt parameter values](https://yookassa.ru/developers/payment-acceptance/receipts/54fz/other-services/parameters-values)
- [Testing — sandbox cards](https://yookassa.ru/developers/payment-acceptance/testing-and-going-live/testing)
- [Changelog 2026](https://yookassa.ru/developers/using-api/changelog)
- [Fees](https://yookassa.ru/fees/)

**54-ФЗ + туристический налог:**
- [TravelLine — НДС 0% до 2030](https://www.travelline.ru/blog/kak-izmenitsya-nds-dlya-gostinits-v-2025-godu-klyuchevye-stavki-i-usloviya-dlya-polucheniya-nds-0/)
- [Yandex Travel Pro — НДС 22%](https://travel.yandex.ru/pro/kak-izmenilsya-nds-dlya-gostinic-v-2026-godu-k-chemu-gotovitsya-oteleram/)
- [nalog-nalog.ru — туристический налог в чеке](https://nalog-nalog.ru/dontknows/kak-probivat-turisticheskij-nalog-v-kassovom-cheke/)
- [Сочи администрация — туристический налог](https://sochi.ru/gorod/turizm/turisticheskiy-nalog/)

**CloudPayments:**
- [CloudPayments developers](https://developers.cloudpayments.ru/en/)
- [CloudKassir developers](https://developers.cloudkassir.ru/en/)
