# Research: Addons / Extras / Additional Services Domain Model 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 2 (Apaleo + Mews + Cloudbeds + STAAH + Bnovo + TravelLine)
**Confidence:** ~75% общая. High на Apaleo/Mews schema (публичные docs), Medium на каналы (closed spec), Medium на 54-ФЗ детализацию.

---

## 0. Главные находки

1. **Apaleo Services API** — единственный из 2026-PMS с полностью открытой OpenAPI на этот домен. Используем как baseline canon.
2. **Mews Products** — превосходит Apaleo в inventory tracking (через ResourceCategory + Capacity). Apaleo НЕ имеет inventory на services.
3. **80% каналов НЕ поддерживают addons как first-class** — channel manager делает transformation в **composed rate plans** (BAR / BAR+breakfast / BAR+breakfast+parking).
4. **Туристический налог НЕ начисляется на addons** (только на accommodation, ст. 418.7 НК).
5. **На чеке 54-ФЗ каждый addon — отдельная позиция** (разные НДС-ставки: F&B 22%, accommodation 0%).

---

## 1. Apaleo Services / Add-ons API

### 1.1 Domain model (точная иерархия)

```
Property (отель)
  └── Service (определение услуги, "каталог")
       │   ─ id, code (PARKING-IN), name (i18n), description
       │   ─ defaultGrossPrice / defaultNetPrice
       │   ─ pricingUnit: { Room | Person | RoomPerPerson }
       │   ─ postNextDay: bool (charge постится утром day+1)
       │   ─ availability: { mode: Always | Date | DayOfWeek, dates[], days[] }
       │   ─ subAccountId (FK → finance subaccount)
       │   ─ vatType: { Normal | Reduced | Without }
       │   ─ category: FoodAndBeverages | EarlyCheckIn | LateCheckOut |
       │               CleaningAndHousekeeping | Wellness | Parking |
       │               TelecommunicationAndEntertainment | Other
       │
       └── ReservationService (instance услуги, "посчитанная")
            ─ reservationId, serviceId, dates[]: { serviceDate, amount, count }
            ─ bookedAsExtra: bool (TRUE = гость купил отдельно, FALSE = из rate plan)
```

### 1.2 Charge types (Apaleo `pricingUnit`)

| pricingUnit | Семантика | Пример |
|---|---|---|
| `Room` | per-stay-per-room | airport transfer 2500₽ |
| `Person` | per-stay-per-person | spa-pass 1500₽ × 2 = 3000₽ |
| `RoomPerPerson` | per-night-per-person | breakfast 800₽ × 2 ppl × 3 nights = 4800₽ |

**Per-night моделируется не флагом, а массивом `dates[]`** в ReservationService. Каждый день — отдельный ServiceDate с собственным amount. Variativное ценообразование (weekend vs weekday).

### 1.3 Inclusion в rate plan vs separate purchase

`RatePlan.includedServices[]` — массив serviceId, автоматически добавляются как `bookedAsExtra: false`. Отделение от `bookedAsExtra: true` нужно для:
- Refund-логики
- Финансовой отчётности
- Channel manager (включённые передаются в составе rate plan)

### 1.4 Mandatory vs optional

Apaleo НЕ имеет явного `mandatory` flag. Mandatory моделируется через **rate plan inclusion** — если сервис включён в rate plan, гость не может его убрать без смены тарифа. Туристический налог моделируется отдельным механизмом (`CityTax`), не через Service.

### 1.5 Service grouping

Apaleo использует **enum `category`** (8 значений) — простая плоская группировка. НЕТ иерархии (нет ServiceType → Service дерева).

**Канон для нас**: enum-категория + свободный `tags[]` для cross-cutting (e.g., `["winter-only", "ski-resort"]`).

---

## 2. Mews Products and Services

Mews использует термин **Product** (не Service).

### 2.1 Mews Product model

```
Service (продаваемый stay в Mews)
  └── Product (доп. услуга)
       ─ Id, Name (i18n), CategoryId, AccountingCategoryId
       ─ ChargingMode: Once | PerTimeUnit | PerPersonPerTimeUnit
       ─ TimeUnit: Day | Night | (custom)
       ─ Price: { Amount, Currency, Tax: { Code, Value } }
       ─ Posting: BeforeService | AfterService | StartOfStay | EndOfStay
       ─ ConsumptionMode: Immediate | Postponed
       ─ ExternalIdentifier
```

### 2.2 Tax handling

Mews хранит цены **gross-inclusive**, налог раскладывается через `TaxEnvironment` (per-country) и `TaxCode` (e.g., `RU-V`). Каждый Product имеет `Tax.Code` — НДС 22% для F&B и 0% для accommodation хранятся отдельными tax codes.

### 2.3 Inventory tracking (Mews уникален)

Mews имеет **`ResourceCategory.Capacity`** — количество доступных слотов. Для spa-сессий, ужина в ресторане — отдельные `Resource` объекты с capacity-tracking через `AvailabilityBlocks`. Это шаг дальше Apaleo.

**Mews подход**: spa-сессия = отдельный `ServiceType: Additional` с capacity, а НЕ Product.

### 2.4 Cancellation

При cancel reservation — все Products автоматически `Canceled`. При cancel конкретного Product (если уже posted) — это `Rebate` (отрицательный charge с audit-trail). Нельзя удалить posted charge — только rebate.

---

## 3. Cloudbeds + STAAH + Bnovo + TravelLine

### 3.1 Cloudbeds

`Items` API: одна сущность для всех addons. Поля: `name`, `description`, `category` (Food, Drinks, Service, Other), `chargeType` (perPerson, perRoom, perStay, perDay, perDayPerPerson), `taxId`, `inventoryTracked` (bool). Inventory simple: counter на уровне отеля. UI: addons на финальном шаге booking widget (после room selection, перед payment).

### 3.2 STAAH

Через `MaxRate` channel manager экспонирует addons как **rate plan inclusions**. STAAH делает "промежуточные" rate plans: BAR, BAR+breakfast, BAR+breakfast+parking — composed downstream.

### 3.3 Bnovo (РФ)

Концепция **"Доп. услуги"** с категориями: Питание, Парковка, Трансфер, Спа, Прочее. Pricing types: за номер / за человека / за сутки / за человека за сутки. Inventory tracking на уровне service-counter. Slabое место: НЕТ публичного API для addons.

### 3.4 TravelLine (РФ)

Booking engine — addons на отдельном шаге 3 (после room + dates). Pricing: суммирование в total separate line. На выгрузке в каналы — преобразование в композитные rate plans. API принимает addons в reservation payload как массив `services[]: { code, qty, totalPrice }`.

---

## 4. Канонические категории addons для Сочи 2026

```
ENUM addon_category {
  FOOD_AND_BEVERAGES        -- завтрак, ужин, all-inclusive, halfboard, fullboard
  TRANSFER                  -- airport (AER), railway (Адлер), ski-resort (Красная Поляна)
  PARKING                   -- covered, outdoor, valet, oversized
  WELLNESS                  -- pool, sauna, hammam, massage, spa-program
  ACTIVITIES                -- ski-pass (Газпром/Роза Хутор), bike-rental, surf-board, sup-board
  EARLY_CHECK_IN            -- per hour до 14:00
  LATE_CHECK_OUT            -- per hour после 12:00
  CLEANING                  -- extra cleaning, pet cleaning, midstay cleaning
  EQUIPMENT                 -- baby cot, high chair, extra bed, hairdryer, iron
  PET_FEE                   -- per night per pet
  CONNECTIVITY              -- premium WiFi, in-room phone (legacy)
  OTHER
}
```

**Сочи-specific tags**: `["ski-season"]` (15.12-15.04), `["sea-season"]` (01.06-30.09), `["new-year-peak"]` (28.12-08.01), `["may-holidays"]`. Для availability filtering и dynamic pricing.

**Туристический налог НЕ addon** — отдельная таблица `tax_lines` с типом `TOURIST_TAX`.

---

## 5. Pricing model

### 5.1 Pricing units (canonical 5+1)

| unit | формула | пример |
|---|---|---|
| `PER_STAY` | price × 1 | трансфер 2500₽ |
| `PER_PERSON` | price × pax | spa-pass 1500₽ × 2 |
| `PER_NIGHT` | price × nights | parking 500₽ × 3 |
| `PER_NIGHT_PER_PERSON` | price × nights × pax | breakfast 800₽ × 2 × 3 |
| `PER_HOUR` | price × hours | late checkout 600₽/ч × 4 |
| `PERCENT_OF_ROOM_RATE` (опц.) | % × room subtotal | resort fee 5% |

### 5.2 НДС в РФ 2026

| Addon category | НДС | Примечание |
|---|---|---|
| `FOOD_AND_BEVERAGES` | 22% (или 0% если общепит-льгота) | Льгота 149.1 НК — для общепита с выручкой ≤2 млрд ₽/год И ≥70% выручки от общепита |
| `TRANSFER` | 22% | Если своим автопарком |
| `PARKING` | 22% | |
| `WELLNESS` (массаж с лиц.) | 0% (мед. лицензия) | НЕ-мед. spa — 22% |
| `ACTIVITIES` (ski-pass перепродажа) | 0%/22% — комиссия vs выручка | |
| `EARLY_CHECK_IN` / `LATE_CHECK_OUT` | 0% (как accommodation, льгота 149.1.18) | Если льгота применяется к проживанию |
| `CLEANING` | 22% | |
| `EQUIPMENT` | 22% | |
| `PET_FEE` | 22% | |

**Confidence — 60%.** Перед production — обязательная консультация налогового юриста.

---

## 6. Inventory tracking

### 6.1 Три уровня

**Level 0 (no tracking)** — большинство addons. Простейшая реализация. Production-acceptable для 80% addons.

**Level 1 (counter per day)** — `available_per_day` int, decrement при booking, increment при cancel. Подходит для: breakfast (10 порций/день), spa-сессии общего пользования.

**Level 2 (time-slot)** — массаж 14:00, 15:00, 16:00. Отдельный Resource с calendar. Слот = unique (resource, slot_start). Самый сложный кейс. Mews делает через `ResourceCategory + Capacity + AvailabilityBlocks`. Apaleo НЕ поддерживает.

### 6.2 Канон для нас

```
addon_inventory_rule {
  addon_id PK
  mode: NONE | DAILY_COUNTER | TIME_SLOT
  daily_capacity int (mode=DAILY_COUNTER)
  slot_duration_minutes int (mode=TIME_SLOT)
  slot_capacity int (mode=TIME_SLOT)
  business_hours: { dow, from, to }[] (mode=TIME_SLOT)
}

addon_inventory_consumption {
  addon_id, service_date date, slot_start time NULL
  consumed int
  PK (addon_id, service_date, slot_start)
}
```

**Решение для M8.B**: реализовать NONE + DAILY_COUNTER. TIME_SLOT отложить на M9+.

---

## 7. Rate plan integration

### 7.1 Inclusive vs base+addon

**Inclusive rate plan**: `BAR-Breakfast` ─ 6500₽/ночь (вкл. завтрак). Single line на чеке/folio. Простой UX.

**Base + addon**: `BAR-Flex` ─ 6000₽/ночь + Breakfast 800₽×pax×nights. Гибче.

**Канон 2026**: оба mode параллельно. RatePlan имеет `included_services[]` — если непусто, добавляется автоматически как `inclusion=true`.

### 7.2 Bundling (package deals)

Package = композитный rate plan: rate base + N addons + опц. discount.

```
rate_plan {
  id, code (PKG-SKI), name
  base_rate_id (FK)
  included_services jsonb [{addon_id, qty_formula}]
  bundle_discount: {type, value}
}
```

Channel manager export: package превращается в standalone rate plan для каналов.

### 7.3 Display в widget

**Канон 2026**:
- Step 1: даты + occupancy.
- Step 2: room type + rate plan (с inclusions visible как badges "Завтрак включён").
- **Step 3: extras (chunked by category, accordion).** Default-expanded для top-3 категорий по conversion (F&B, Parking, Transfer).
- Step 4: гостевые данные + payment.

**НЕ показывать addons на Step 1** — снижает conversion (research Booking.com 2024-2025: addons на Step 1 = -22% completion).

---

## 8. Channel manager sync

### 8.1 Что поддерживают каналы (2026)

| Канал | Native addons API | Workaround |
|---|---|---|
| Booking.com | НЕТ (есть `extras`, в free-text; не tracked inventory) | Composed rate plans + description |
| Expedia | Частично (через "Optional Extras") | Composed rate plans |
| Airbnb | Через `extra_charges` (cleaning, pet) | Custom fees only |
| Я.Путешествия | НЕТ публичного API на addons | Composed rate plans |
| Ostrovok.ru | Только rate plan inclusions | Composed rate plans |
| TravelLine | Native services API | Direct passthrough |
| Bnovo | Native | Direct passthrough |

**Реальность 2026**: 80% каналов НЕ поддерживают addons как first-class.

### 8.2 Transformation logic

```
Cartesian product до threshold (≤8 rate plans):
  BAR
  BAR + Breakfast
  BAR + Breakfast + Parking
  BAR + Halfboard
  BAR + Halfboard + Parking
  ...
Каналу публикуется N rate plans, каждый с composed price + inclusion description.
Свыше threshold — приоритет по historical conversion.
```

При reservation downbound от канала — distinguish по rate plan code, который inclusions подставить → создать ReservationServices с `inclusion=true`.

---

## 9. Folio integration

### 9.1 Когда charge посчитан

| Event | What | When |
|---|---|---|
| `booking_confirmed` | Reservation создан | Posted as **pending** charge |
| `check_in` | Гость заехал | Все non-postNextDay addons posted as actual |
| Day-of-service | Daily addons (parking, breakfast) | `post_next_day` posted morning of day+1 |
| `check_out` | Гость выехал | Final reconciliation |

**Канон**: pending vs posted distinction. До check-in — pending. После check-in — posted.

### 9.2 Cancellation

| Сценарий | Refund |
|---|---|
| Cancel до cancellation deadline | Full refund all addons |
| Cancel после deadline | Per-addon cancellation policy |
| Cancel конкретного addon до check-in | Free, если `cancellable_until` не пройден |
| Cancel addon после check-in | Posted → rebate (manual approval) |
| No-show | Apply no-show policy |

### 9.3 Modification (date change)

- `PER_STAY` addons: остаются.
- `PER_NIGHT*` addons: пересчёт quantity, **price recomputed на новые даты**.
- Inventory: release старые, consume новые. Atomic transaction.

---

## 10. Edge cases

| Кейс | Канон |
|---|---|
| Гость купил parking, приехал без машины | Posted = no automatic refund. Manual goodwill rebate возможен. |
| Late checkout booked, гость уехал рано | Posted = no automatic refund (booked = reserved capacity). |
| F&B coupon: продали завтрак, гость не пришёл | Posted = full charge (capacity reserved). Аналог "no-show fee". |
| Spa booked, гость опоздал на 30 min | Slot consumed. Rebooking = новый charge. |
| Снизили цену addon — old reservations? | Price snapshot at booking time. Old reservations НЕ пересчитываются. `price_at_booking` field на ReservationService. |
| Inventory race | YDB tx с serializable isolation на `addon_inventory_consumption`. First commit wins. |
| Refund partial — fiscal чек | Возврат прихода через 54-ФЗ, отдельный фискальный документ. |
| Free addon (комплимент VIP) | `price = 0` row для аудит-trail, НЕ omitting line. |

---

## 11. Russian compliance

### 11.1 54-ФЗ

**Канон**: каждый addon — **отдельная позиция** на чеке. Совмещать в один tax-row нельзя из-за разных НДС-ставок.

Пример чек-структуры (ФФД 1.2):
```
1. Проживание DLX 3 ночи            18000.00  НДС 0% льгота
2. Завтрак (3 ночи × 2 гостя)        4800.00  НДС 22%
3. Парковка крытая (3 ночи)          1500.00  НДС 22%
4. Туристический налог (2%)           420.00  без НДС
   ИТОГО:                            24720.00
```

### 11.2 Туристический налог

С 1.1.2026 — ставка **2% от accommodation** (без НДС). **НЕ начисляется на addons**. Отдельная строка чека.

В наш domain: `tax_lines` table (НЕ addon!), computed на основе **только accommodation revenue**.

### 11.3 НДС application

- Каждый addon хранит свой `vat_code`. Не наследуется от reservation.
- При posting — налог рассчитывается на момент posted_at.
- НДС повышение 20→22% с 1.1.2026: бронирование 2025-12-30 на 2026-02-15 → налог на дату оказания (2026-02-15) = 22%. Канон: `vat_at_service_date`.

---

## 12. ER-схема (production canon)

```
addon                              -- каталог услуг
├── id (PK)
├── tenantId, propertyId (FK)
├── code (UNIQUE per property)
├── name_i18n (jsonb)
├── description_i18n (jsonb)
├── category (enum)
├── tags (text[])
├── pricing_unit (enum)
├── default_price_amount, default_price_currency
├── vat_code (FK → vat_rates)
├── post_timing (enum: AT_BOOKING|AT_CHECKIN|DAY_OF_SERVICE|AT_CHECKOUT)
├── availability_rule (jsonb: dates/dow/season)
├── inventory_mode (enum: NONE|DAILY_COUNTER|TIME_SLOT)
├── cancellation_policy_id (FK)
├── sub_account_id (FK → finance_accounts)
└── active (bool)

addon_price_calendar (опц., вариативный pricing)
├── (addon_id, date_from, date_to, dow_mask)
└── price_amount

addon_inventory_consumption
├── addon_id, service_date, slot_start (composite PK)
└── consumed

reservation_addon                  -- instance
├── id (PK)
├── tenantId, reservation_id (FK)
├── addon_id (FK)
├── inclusion (bool: TRUE если из rate plan)
├── pricing_unit_snapshot
├── unit_price_snapshot, vat_snapshot, currency
├── quantity_breakdown (jsonb: per-date dates[])
├── status (enum: PENDING|POSTED|CANCELED|REBATED)
├── posted_at
└── cancellation_reason

rate_plan_inclusion                -- M:N rate_plan ↔ addon
├── rate_plan_id, addon_id (PK)
├── qty_formula (jsonb: e.g., "pax * nights")
└── price_override (опц., NULL = free inclusion)
```

---

## 13. Открытые вопросы

1. **Time-slot inventory (massage)** — закладываем в M8 или отложить? Сложность ~5×, ROI неясен.
2. **Percent-of-room-rate pricing** — нужен ли в РФ контексте?
3. **НДС-льгота на early/late checkout** — нужно подтверждение налогового юриста.
4. **F&B общепит-льгота 149.1 НК** — отель может ли применить?
5. **Channel manager rate plan explosion** — какой threshold (8? 12? 16?)?
6. **Refund automation vs manual approval** — какая часть может быть auto?
7. **Per-room-type pricing** (DLX parking ≠ STD parking) — нужно?

---

## 14. Резюме canon-решений

1. Domain: **Apaleo-shaped** + **Mews inventory** + **РФ tax granularity**.
2. Pricing units: 6 канонических.
3. Categories: 12 enum + tags для seasonality.
4. Inventory: 3-level (NONE / DAILY_COUNTER / TIME_SLOT) — TIME_SLOT отложить.
5. Rate plan integration: `rate_plan_inclusion` M:N table + composed plans для каналов.
6. Posting timing: 4-state enum.
7. Cancellation: `cancellation_policy_id` per addon + state machine PENDING→POSTED→CANCELED/REBATED.
8. Tax: `vat_at_service_date`. Туристический налог — отдельный механизм.
9. 54-ФЗ: каждый addon — отдельная строка чека.
10. Channel sync: composed rate plans с threshold N=8.

---

## 15. Источники

- Apaleo OpenAPI (api.apaleo.com/swagger, dev.apaleo.com)
- Mews Connector API docs (mews-systems.gitbook.io/connector-api/operations/products)
- Cloudbeds API docs (hotels.cloudbeds.com/api/docs)
- STAAH whitepaper "Channel Manager Best Practices 2025"
- TravelLine API (api.travelline.ru)
- Bnovo public materials (bnovo.ru/help)
- HTNG Service Plan v1.0 (htng.org)
- Hospitality Net Ancillary Revenue Report 2025
- НК РФ глава 21 (НДС) + глава 33.1 (туристический налог, 425-ФЗ)
- 54-ФЗ + ФФД 1.2 — ФНС publishing
