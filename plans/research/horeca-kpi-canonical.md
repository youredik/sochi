# Research: Канонические KPI для отельного бизнеса 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 2 (синтез STR + USALI 11th Rev + Apaleo + Mews + Cloudbeds + RU компании)
**Confidence:** High (definitions), Medium (точные tradeoffs by provider)

---

## 0. Главные находки (TL;DR)

1. **USALI 11th Revised Edition (2024)** — текущий canon. Вступил в силу с фискальных лет 2024-2025. Apaleo и Mews уже соответствуют.
2. **Cancellation/no-show fees ВЫНЕСЕНЫ из Room Revenue** — это самое важное изменение. Раньше многие операторы их включали в ADR — теперь это НЕ best-practice.
3. **ADR всегда net of VAT и net of tourist tax** (canonical, не optional).
4. **Resort fees mandatory** — IN Room Revenue (USALI 11th Rev явно).
5. **OOO/OOS** — две версии considerations:
   - **STR canon** (бенчмарк): OOO/OOS считаются Available.
   - **Operational canon** (Apaleo, Mews, Cloudbeds): OOO/OOS вычитаются из Available.
6. **Daily GOPPAR практически невозможен** — monthly стандарт.

---

## 1. Канонические определения базовых KPI

### 1.1 Occupancy (Загрузка)

**Формула**:
```
Occupancy = Rooms Sold / Rooms Available
```

**Rooms Available** = total physical inventory − **permanently inactive rooms** (renovation > длительный, demolished).

**OOO/OOS — ключевая развилка 2026**:

| Подход | OOO в Available? | Кто использует |
|---|---|---|
| **STR canon** (бенчмарк) | **ДА, OOO/OOS считаются Available** | STR, HotStats, отчёты для инвесторов |
| **Operational view** | НЕТ, OOO/OOS вычитаются | Apaleo "Operational Occupancy", Mews "Available Rooms (excl. out of order)" |
| **USALI 11th Rev (2024)** | Рекомендует ПОКАЗЫВАТЬ ОБА | Финансовая отчётность |

**Решение для нашего KPI-движка**: считать **обе версии**, default UI — Operational (excl. OOO), при бенчмарк-сравнении переключать на STR-style.

**Out-of-Inventory (OOI)**: помещение вообще выведено из продажи (склад, офис). НЕ available ни в одной формуле.

### 1.2 ADR (Average Daily Rate)

**Формула**:
```
ADR = Room Revenue / Rooms Sold
```

**Что входит в Room Revenue (USALI 11th Rev 2026 canon)**:

| Компонент | В Room Revenue для ADR? | Источник |
|---|---|---|
| Чистая стоимость номера (за вычетом скидок) | **ДА** | USALI, STR |
| НДС / VAT | **НЕТ** (всегда **net of taxes**) | USALI canon |
| Туристический налог 2% Сочи | **НЕТ** (отдельная "pass-through") | USALI, STR |
| Resort fee / mandatory service fee | **ДА** (если non-optional) | **USALI 11th Rev — теперь явно включается** |
| Завтрак (BB included) | **ЗАВИСИТ от package allocation**: если single-rate package — ВЫЧИТАЕТСЯ из Room Revenue по internal transfer rate | USALI Package Breakdown |
| Завтрак отдельно | НЕТ (F&B Revenue) | USALI |
| Парковка | НЕТ (Other Operated Departments) | USALI |
| Трансфер | НЕТ | USALI |
| **Cancellation fees** | **НЕТ → "Miscellaneous Income"** | **USALI 11th Rev — явно вынесена** |
| **No-show fees** | **НЕТ → "No-Show Revenue"** | **USALI 11th Rev** |
| Early departure fee | НЕТ (Miscellaneous) | USALI |
| Late checkout fee | НЕТ если отдельный charge; ДА если продолжение тарифа | USALI |
| Комиссии OTA (Booking 17%, Я.П 17%) | Отображается **GROSS**, комиссия — отдельная **expense** | STR, USALI |

**Net ADR** (после OTA-комиссии) — supplementary метрика, не замена ADR.

### 1.3 RevPAR (Revenue Per Available Room)

**Две эквивалентные формулы**:
```
RevPAR = Room Revenue / Rooms Available
RevPAR = Occupancy × ADR
```

**В 2026 индустриальный канон — первая формула** (revenue/available):
- Не зависит от round-off в Occupancy/ADR.
- Apaleo, Mews, Cloudbeds считают именно так.
- При Rooms Sold = 0, ADR undefined, но RevPAR корректно = 0 через первую формулу.

**Net RevPAR** = (Room Revenue − Distribution Costs − Transaction Fees) / Rooms Available. Используется HotStats и Apaleo (опционально).

### 1.4 GOPPAR (Gross Operating Profit Per Available Room)

**Формула**:
```
GOPPAR = (Total Revenue − Departmental Expenses − Undistributed Operating Expenses) / Rooms Available
       = Gross Operating Profit / Rooms Available
```

**Вычитаем (USALI 11th Rev)**:
- **Departmental Expenses**: rooms (housekeeping labor, supplies, laundry), F&B (food cost, beverage cost).
- **Undistributed Operating**: Administrative & General, Information & Telecommunications, Sales & Marketing, Property Operations & Maintenance, Utilities.

**НЕ вычитаем**:
- Management fees
- Property taxes / insurance / rent
- Depreciation / amortization
- Interest

**Daily GOPPAR — практически невозможен точно, monthly — стандарт.**

**Решение для M8.D:** GOPPAR показываем **monthly**, не daily. Daily-уровень = только Occ/ADR/RevPAR.

### 1.5 TRevPAR (Total Revenue Per Available Room)

```
TRevPAR = Total Revenue / Rooms Available
```

Total Revenue = Room + F&B + Other Operated Departments + Miscellaneous Income.

Не включает: Rentals & Other Income.

### 1.6 CPOR (Cost Per Occupied Room)

```
CPOR = Total Operating Costs / Rooms Sold
```

или узко:
```
Rooms CPOR = Rooms Department Expenses / Rooms Sold
```

---

## 2. Гранулярность

### 2.1 Daily vs Running Totals

**Канон**:
- **Daily KPI** — за конкретную ночь.
- **MTD / YTD / Trailing 30/90/365** — running totals, агрегируются как `sum(Revenue) / sum(Available)`, **НЕ как `avg(daily_RevPAR)`**.

Это критично: средневзвешенное от daily-RevPAR ≠ period RevPAR при изменении daily Available.

### 2.2 Per-Property vs Aggregate

- **Per-property** — primary view.
- **Aggregate** — `sum(Room Revenue) / sum(Rooms Available)`.
- НЕЛЬЗЯ усреднять property-level RevPAR без weighting.

### 2.3 Per-Room-Type

Apaleo и Mews считают KPI **per Unit Group / Room Category**:
- Available = inventory этого типа.
- Sold = bookings в этот тип.

### 2.4 Time-window сравнения

STR-стандарт:
- **MPI (Market Penetration Index)** = (Hotel Occ / Comp Set Occ) × 100
- **ARI (Average Rate Index)** = (Hotel ADR / Comp Set ADR) × 100
- **RGI (RevPAR Index)** = (Hotel RevPAR / Comp Set RevPAR) × 100

100 = fair share; >100 = outperform.

Self-comparison:
- **YoY** — same calendar period prior year (с учётом дня недели, не just "29 апреля 2025").
- **STLY (Same Time Last Year)** — pace metric.

---

## 3. Edge Cases — однозначные правила

| Сценарий | Правило |
|---|---|
| Occupancy = 0 | ADR = `null`, RevPAR = 0 |
| Нет revenue, есть occupied (только comp) | ADR = 0 (если comp в Sold) или null |
| OOO/OOS rooms | Default operational (excl). Toggle на STR-mode |
| Group blocks (не подтверждённые) | НЕ Sold пока не превратились в reservations |
| Comp rooms (бесплатные апгрейды) | **В Rooms Sold (Occ ↑), НО НЕ в Room Revenue (ADR ↓)**. STR canon. UI: "Paid Occupancy" + "Total Occupancy" |
| Day-use (без overnight) | НЕ занимает room-night; revenue → "Other Room Revenue"; **НЕ влияет на ADR/RevPAR** |
| Multi-night booking | Revenue allocated **per night equally** (или per-night actual если rate plan варьирует) |
| No-show | **НЕ занимает room-night**, no-show fee → Miscellaneous |
| Walk-in | С момента check-in, не ретроактивно |
| Early checkout | Already-consumed nights остаются Sold; refunded — НЕ Sold |
| Stay-over crossing month | Каждая ночь → к своему месяцу |
| House use rooms | Apaleo/Mews — отдельный bucket, не в Available |
| Posting after the fact | Идёт в day когда service consumed, не posted (accrual basis) |

---

## 4. Apaleo / Mews / Cloudbeds — фактическая реализация

### 4.1 Apaleo

- **Available Rooms** = total active − OOO − OOS (operational by default). Toggle через query param.
- **Rooms Sold** = по `night-stays` (не reservations). Day-use отделена.
- **Room Revenue** = sum of `services.Accommodation` posted to folio, **net of VAT, net of city tax**. Resort fee если non-optional → внутри Accommodation.
- **ADR** = Room Revenue / Rooms Sold (paid only, comp excluded).
- **RevPAR** = Room Revenue / Available Rooms.
- **Cancellation fee** → service `CancellationFee`, в `Other Revenue`.
- **No-show fee** → service `NoShowFee`, в `Other Revenue`.
- **Per Unit Group** breakdown — primary.

### 4.2 Mews

- **Available Rooms** = configured bookable spaces. OOO = "Out of Service blocks" вычитаются.
- **Occupancy** показано в **двух версиях**: "Occupancy" (excl. OOO) и "Occupancy with OOO".
- **Net ADR** = Room Revenue (net) / Rooms Sold. **По умолчанию net of VAT**.
- **F&B и Other Services** — separate revenue buckets, в TRevPAR включены.

### 4.3 Cloudbeds

- **Available Rooms** = active − OOO. Cloudbeds НЕ считает OOO как available.
- **ADR** опционально gross или net (настраивается).
- **Cancellation revenue** — отдельный bucket.
- Per-source breakdown (Booking.com/Expedia/Direct) — primary cut.

### 4.4 Сводка различий

| Aspect | Apaleo | Mews | Cloudbeds | STR canon |
|---|---|---|---|---|
| OOO в Available | excl (default) | оба | excl | **incl** |
| ADR net of VAT | да | да | toggle | да |
| Cancel fee в Room Rev | нет | нет | нет | нет (USALI 11) |
| Resort fee в Room Rev | да если mandatory | да | да | да |
| Day-use в Occupancy | нет | нет | toggle | нет |
| Comp в Sold | toggle | toggle | да | да |

**Решение для нашего движка**: следовать **Apaleo-style canon** + давать toggle на STR-mode для OOO.

---

## 5. STR / Smith Travel Research

- **Stop-sell**: room остаётся available, просто not sellable at that rate. Available count НЕ меняется. Это не OOO.
- **Net Room Revenue** = Gross − Allowances − Rebates − Refunds. **НЕ** вычитается OTA commission (это expense).
- **Day Spa, F&B, parking** = SEPARATE METRICS, не в Room Revenue. В TRevPAR.
- **STR не публикует cancellation/no-show fees отдельно**.

---

## 6. Российская специфика

### 6.1 Туристический налог 2% Сочи 2026

- **425-ФЗ** ввёл с 1.1.2026 как замену курортному сбору.
- Ставка 2% от стоимости номера в Сочи на 2026 (растёт до 5% к 2029).
- **НЕ входит в Room Revenue для ADR/RevPAR** (как и occupancy tax/city tax в США).
- Code: отдельная статья `TouristTaxLine` в folio, ADR без неё.
- В чеке ККТ (54-ФЗ) — отдельной строкой.
- **Минимум 100 ₽/сутки** даже если 2% < 100 ₽.

### 6.2 НДС 0% accommodation, 22% F&B (с 2026)

- **С 2026 НДС 22% (с 20%)** — учесть в hardcoded налоговых формулах.
- Гостиничные услуги — нулевая ставка 0% (продлено до 2030).
- F&B — 22%.
- ADR/RevPAR в России — **net of VAT**.
- УСН без НДС — формулы те же.

### 6.3 РФ-локальные источники

- **Bnovo CM** публикует "Аналитика" с RevPAR/ADR — формулы соответствуют STR.
- **TravelLine** — то же.
- **Контур.Отель** — расчёт занятости с OOO в operational view.

**Решение**: следуем международному канону + туристический налог + НДС 22% expressly excluded из ADR.

---

## 7. Дополнительные метрики

| Метрика | Формула | Назначение |
|---|---|---|
| **Booking Pace** | Reservations per day по arrival window (0-7d, 8-30d, 31-90d, 90+) | Тренд набора будущих дат |
| **Lead Time** | avg(arrival_date − created_date) | Насколько вперёд бронируют |
| **Length of Stay** (ALOS) | sum(nights) / count(reservations) | Поведение гостей |
| **Cancellation Rate** | cancelled / (cancelled + arrived + active) на cohort created-date | Качество прогноза |
| **No-Show Rate** | no_show / arrived | Discipline guarantee policy |
| **Channel Mix** | room_nights_by_channel / total × 100% | Зависимость от OTA |
| **Direct vs OTA Revenue** | direct_revenue / total_revenue | Доля без комиссий |
| **Repeat Guest Rate** | unique_guests_with_2+_stays / unique_guests | Лояльность |
| **Conversion Rate** | confirmed / inquiries | Sales funnel |
| **Cancel-to-Book Ratio** | cancellations / new_bookings | Operational pressure |
| **OOO Days** | sum of nights × OOO units | Maintenance impact |
| **Arrivals/Departures count** | по календарю | Operational planning |
| **Forward Occupancy / On-the-Books** | sold_for_future_date / available_for_future_date | Pace KPI |
| **Pace Curve** | cumulative bookings vs days-to-arrival | Распределение pickup |
| **Wash Factor** | actual_arrived / on-the-books_at_-7d | Reliability of pace |

**Российский фокус для Сочи**:
- **Booking pace** — сезонность жёсткая (mai-октябрь vs январь-апрель).
- **Channel mix** — Я.Путешествия + Ostrovok доминируют.
- **Lead time** — российский гость бронирует ближе к дате чем западный.

---

## 8. Решения для нашего KPI-движка (M8.D)

### 8.1 Schema (миграция 0025_kpi_materialized.sql)

```
kpi_occupancy_daily
  tenantId, propertyId, date
  totalRooms (snapshot - OOI)
  oooRooms (snapshot)
  oosRooms (snapshot)
  occupiedRooms (paid)
  compRooms (free upgrades)
  occupancyOperationalPercent (Apaleo-style: occupied / (total - OOO - OOS))
  occupancyStrPercent (STR-style: occupied / total)
  paidOccupancyPercent (paid / available, без comp)
  computedAt
  PK (tenantId, propertyId, date)

kpi_revenue_daily
  tenantId, propertyId, date
  roomRevenueMicros (net of VAT, net of tourist tax, includes resort fees)
  cancellationFeeMicros (отдельно)
  noShowFeeMicros (отдельно)
  fbRevenueMicros
  addonRevenueMicros (parking, spa, transfer)
  totalRevenueMicros
  occupiedRoomsForAdr (paid only, comp excluded)
  adrMicros (room_revenue / occupied)
  revparMicros (room_revenue / available)
  trevparMicros (total_revenue / available)
  computedAt
  PK (tenantId, propertyId, date)

kpi_pace_snapshot
  tenantId, propertyId, snapshotDate, arrivalWindow (0-7d, 8-30d, 31-90d, 91+)
  newBookings, cancellations
  PK (tenantId, propertyId, snapshotDate, arrivalWindow)
```

### 8.2 Endpoints

```
GET /api/v1/kpi/occupancy?from&to&propertyId&granularity=day|week|month&mode=operational|str
GET /api/v1/kpi/adr?...
GET /api/v1/kpi/revpar?...
GET /api/v1/kpi/summary?from&to            # все три + bonus
GET /api/v1/kpi/pace?propertyId            # forward booking distribution
GET /api/v1/kpi/channel-mix?from&to        # источники
GET /api/v1/kpi/cancellation-rate?from&to
```

### 8.3 Aggregation rule (важно!)

**Aggregate period KPI** = `sum(num) / sum(denom)`, не `avg(daily)`.

```ts
// CORRECT
periodOccupancy = sum(occupiedRooms) / sum(availableRooms)

// WRONG
periodOccupancy = avg(dailyOccupancy)
```

---

## 9. Открытые вопросы

1. **Comp rooms в Occupancy** — STR: include, многие revenue-managers исключают для "Paid Occupancy". Нужны обе версии.
2. **House use rooms** — отдельный bucket, не считать ни там ни там.
3. **Day-use revenue** — Room или Other? USALI 11 рекомендует Other Room Revenue (sub-line).
4. **OTA commissions** — contra-revenue vs expense. USALI: expense. Booking.com показывает gross.
5. **Resort fees** после USALI 11 явно в Room Revenue, но FTC США запретили скрытые "junk fees" в 2024.
6. **Daily GOPPAR feasibility** — нет industry-стандарта daily-allocation indirect costs.
7. **STLY pace methodology** — calendar-day vs day-of-week alignment.
8. **Туристический налог 2026 в России** — pace 4 месяца действия; локальный indust консенсус не оформлен.

---

## 10. TL;DR применимый сразу к коду

1. **Room Revenue (для ADR/RevPAR)** = `accommodation_charges` − `vat` − `tourist_tax` − `cancellation_fees` − `no_show_fees` − `addons (F&B, parking, transfer)`. Resort fee mandatory — IN. Discounts — net.
2. **Available Rooms** = active inventory − OOO − OOS (default operational), с toggle на STR-mode.
3. **Rooms Sold** = sum of `night_occupied`, day-use отдельно, comp в "Total Occupancy" но не в "Paid Occupancy".
4. **ADR** = `null` при Sold = 0; RevPAR = 0 при Revenue = 0.
5. **GOPPAR** — monthly only.
6. **Multi-night booking** → revenue accrual per-night.
7. **Aggregate period KPI** = `sum(num) / sum(denom)`, не `avg(daily)`.
8. **Per-property + per-room-type breakdowns** — primary cuts.
9. **YoY** — day-of-week aligned, не calendar-aligned.
10. **РФ локализация**: tourist tax 2% Сочи + НДС 22% всегда вне ADR.

---

## 11. Источники

**Первичные канонические:**
- USALI 11th Revised Edition (2024), Hotel Association of New York City + AHLA
- STR Glossary 2026 (str.com/glossary)
- Apaleo Reports API documentation (apaleo.dev)
- Mews Help Center — Manager Report, Statistics articles
- Cloudbeds Insights — Reports Dictionary

**Вторичные:**
- HotStats blog — KPI definitions 2025
- Hospitality Net articles
- Hotel Tech Report — KPI guides

**РФ:**
- 425-ФЗ от 2024-12-12 (туристический налог)
- НДС 22% — НК РФ изменения 2026
- Bnovo Knowledge Base
- TravelLine блог
