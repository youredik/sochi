# Research: Channel Manager × 3 (TravelLine, Ostrovok/ETG, Яндекс Путешествия)

**Дата:** 2026-04-27
**Источник:** research-агент волны 1
**Confidence:** TravelLine **High (8/10)** — публичный API; Ostrovok/ETG **Medium-High (7/10)** — distribution API публичен, но supplier-flow только через CM-посредника; Яндекс Путешествия **Medium-Low (5/10)** — supplier API закрыт NDA-программой

---

## 0. Channel Manager Patterns 2026 (общий контекст)

### 0.1 Архитектурные паттерны

**Push vs Pull для ARI (Availability/Rates/Inventory):**

В 2026 индустрия консолидировалась вокруг:
- **Push от Channel Manager к OTA** для ARI.
- **Pull или webhook от OTA к Channel Manager** для bookings.

PMS отправляет ARI в CM (push), CM пушит в OTA (push), OTA отдают броники назад (либо webhook, либо CM polls). Чистый polling-only встречается только у legacy XML-партнёров.

**Webhook первенство:** SiteMinder, Cloudbeds, Channex, NextPax — все позиционируют webhook (POST JSON) как primary delivery mechanism для bookings. Polling — fallback / reconciliation.

**Стандарт сообщений:** OpenTravel Alliance OTA_HotelAvailNotifRQ остаётся industry baseline для XML-channels (Booking.com B.XML, Expedia EQC). Modern players (Channex, NextPax, Mews CM) — JSON-REST. Booking.com остаётся XML-only в 2026.

### 0.2 Pooled vs Allocated Inventory — победитель 2026

**Pooled wins decisively.**

Cloudbeds, SiteMinder, STAAH, RateGain Uno Connect, Channex — все маркетируют pooled inventory как key feature. Reasoning: при allocated (квота на канал) либо overbooking, либо underselling. Pooled = единый bucket inventory, CM уменьшает доступность во всех каналах при любой брони.

**Trade-off pooled:** требует sub-second ARI sync и deterministic ordering. Решение индустрии: **idempotent ARI updates с monotonic version per (room_type, date)** + retry-safe queue.

**Allocated всё ещё актуален** для:
- Group blocks / wholesale (DerbySoft, HotelBeds B2B).
- Cap-and-protect стратегии для anti-overbooking buffer.

### 0.3 Conflict resolution

Реальные системы handle overbooking так:
1. **Optimistic ARI sync** — пушим в OTA "rooms=0" сразу после брони (CM-side, не PMS-side).
2. **Sync gap mitigation** — pre-emptive availability buffer на 1 unit на channel при near-sellout.
3. **Revenue-prioritized resolution** при коллизии: walked guest идёт в lowest-rate channel.
4. **"Stop-sell" override** — на rate-plan уровне распространяется на все каналы немедленно.

### 0.4 Rate Parity 2026

EU DMA (Digital Markets Act, ст. 5(3)) запретил Booking.com **wide и narrow** parity clauses. С июля 2024 Booking.com убрал parity из контрактов в EU. **В России юридически parity clauses не запрещены**, но фактическая практика OTA — мониторят дешёвые цены через rate-shopper, при нарушении понижают rank/visibility (soft enforcement без штрафов).

Для нашего mock: реализуем `parity_check` warning, но не enforced violation.

---

## 1. TravelLine — Confidence High (8/10)

### 1.1 API доступ

- **Публичный API:** да, `https://www.travelline.ru/dev-portal/docs/api/`
- **Получатели:** партнёры (channel-of-sales, PMS-вендоры, метапоисковики). Анкета → certification → client_id/secret. Срок 2-3 рабочих дня.
- **Sandbox:** есть, отдельный environment.
- **Authentication:** OAuth 2.0 Client Credentials Flow → JWT access token, **TTL 15 минут**. Authorization endpoint: `https://partner.tlintegration.com/auth/token`.
- **API surface (5 продуктов):**
  - **Content API** — property/room types/amenities/meal plans/cancellation rules
  - **Search API** — поиск комнат и тарифов с ценами
  - **Read Reservation API** — чтение бронирований
  - **PMS Universal API** — `/v2/properties/{propertyId}/reservations/{number}`, `assign-rooms`, `check-in/out`, `payment`, `refund`
  - **Public Reviews API**
- **Rate limits:** 3 req/sec, 15 req/min, 300 req/hour per IP на authorization. Headers `x-ratelimit-remaining-{hour,minute,second}`. 429 → `retry-after`.

### 1.2 Inventory model

- **Per-room-type granularity** (категории номеров).
- **Daily grid.**
- **Pooled** (single inventory bucket per room type).

### 1.3 Rates model

- **BAR-flex и BAR-NR** поддержаны (cancellation rules — отдельная сущность).
- **Special rates:** early-bird, last-minute, длительное проживание, корпоративные.
- **Currency:** RUB, налоги inclusive.
- **Туристический налог Сочи 2%** — отдельной строкой fee.
- **Restrictions:** min/max nights, CTA, CTD, stop-sell, release period.

### 1.4 Booking pull

- **Polling-based** (Read Reservation API).
- **Webhook explicit support публично НЕ подтверждён** — для каналов продаж сказано «не требуют уведомлений, т.к. сами создают брони через API». Для PMS-интеграций — polling по `last-modified`.
- **Booking object:** guest data, dates, room/rate, status, payment info, optional `pmsRoomStayId`.
- **Idempotency:** через `CreateBookingToken` (24h TTL, single-use) + `Checksum` (hash от стоимости/дат/штрафа).
- **Cancellation:** через тот же reservation stream, статус меняется. Отдельного cancellation API нет.
- **Performance:** create p90 = 3695ms, read p90 = 638ms (TravelLine публикует SLA).

### 1.5 Errors

Стандартный HTTP: 400/401/403/404/429/500. Domain errors поверх 400 с code+message. Throttling — 429 + `retry-after`. Exponential backoff guidance не публикован.

### 1.6 Идиоматика и подводные камни

- **Hash-checksum обязателен** при бронировании — anti-tampering защита от подделки цены.
- **CreateBookingToken — 24h, single-use.**
- **Двойная роль:** TL — это и CM (для отельера), и Channel-of-Sales API (для метапоисковика типа Я.Путешествий, который выкупает у TL).
- **Сертификация обязательна** — нельзя продакшн без passing certification suite.
- Узкий Sandbox dataset — рекомендуется готовить свои фикстуры.

---

## 2. Ostrovok / ETG (Emerging Travel Group) — Confidence Medium-High (7/10)

### 2.1 API доступ

- **Публичный API:** ETG API v3 — `https://docs.emergingtravel.com/`, Postman workspace `https://www.postman.com/ostrovok/`.
- **Получатели:** **distributors / B2B resellers** — критическая особенность. ETG API — это **distribution/B2B API** для тех, кто **продаёт** отели ETG. **НЕ для отельера** и не для CM.
- Для **отельера** путь к Ostrovok — через extranet `https://extranet.emergingtravel.com/v3/login` + connection через channel manager (Bnovo, TravelLine, SmartHOTEL, Cloudbeds myallocator).
- **Прямого supplier-API без посредника-CM не публикуется.**
- **Sandbox:** `api-sandbox.worldota.net` (production: `api.worldota.net`).
- **Authentication:** Basic Auth (id + uuid pair).
- **SDK:** официальные Python (`papi-sdk-python`) и PHP (`papi-sdk-php`).

### 2.2 Inventory model (B2B perspective)

- ETG aggregirует inventory от **4 брендов:** Ostrovok + Ostrovok B2B + RateHawk + ZenHotels.
- Distributor pulls availability через `search/serp` (region/hotel/geo) → `hotelpage` (детали) → `prebook` (verify) → `book` → `order/info` → `cancel`.
- Static data: **weekly full hotel dump** + **daily incremental dump** + per-hotel content endpoint.

### 2.3 Rates model

- BAR-flex и BAR-NR различимы через `cancellation_info` объект.
- Rate plans с `meal`, `payment_options`, `cancellation_penalties`, `taxes_and_fees`.
- Multi-currency, taxes inclusive/exclusive — оба варианта.
- Restrictions проверяются через **`prebook` step** — обязательная верификация перед `book`.

### 2.4 Booking pull (distributor side)

- **Order info pull:** `GET /api/b2b/v3/order/info/`. Filter по дате модификации.
- **Webhook поддерживается** — distributor может зарегистрировать callback. Integration Guide: «Check status (or receive webhook)».
- **Idempotency:** `partner_order_id` (distributor's own UUID).
- **Cancellation:** `POST /api/b2b/v3/order/cancel/` — separate endpoint.

### 2.5 Errors

Postman collection раскрывает:
- `invalid_credentials`, `invalid_request`, `internal_error`.
- Domain: `not_available`, `partial_unavailable`, `prebook_required`, `price_changed` (rate changed since search — обязательный re-prebook).
- Rate limits — НЕ задокументированы публично.

### 2.6 Идиоматика и подводные камни

- **Это distribution API, не supplier API.** Любой mock «пушим availability в Ostrovok» — концептуально неверный без посредника-CM.
- **Prebook обязателен** — пропуск = high book-failure rate.
- **Hotel ID mapping** — ETG hotel_id ≠ внутренний ID отеля; static dumps надо матчить.
- **Sandbox содержит реальные search responses** — booking idemотент.

---

## 3. Яндекс Путешествия — Confidence Medium-Low (5/10)

### 3.1 ⚠️ Критически: два разных API

**A. Partner Network API** — `https://yandex.ru/dev/travel-partners-api/`
- Для **affiliates / aggregators** — кто хочет показывать у себя hotel inventory из Я.Путешествий.
- **НЕ для отельера** и не для CM.
- Endpoints: `GET hotels/booking/offers/{offer_id}`, `POST hotels/booking/orders/create`, `POST hotels/booking/orders/{order_id}/payment/start`, etc.
- Authorization: OAuth-token + headers `User-Agent`, `User-IP`, `X-Ya-Session-Key` (max 64, GUID).
- Требование: 5 000+ MAU контентного проекта.

**B. Hotelier Extranet** — `travel.yandex.ru/extranet/`
- Для **отельеров** напрямую.
- **Публичного supplier-API НЕТ.** Только через сертифицированных Channel Managers либо ручное управление через Extranet UI.
- Сертифицированные CM (на 2026): **Bnovo, BookingLite, Бронируй Онлайн, Контур.Отель, LitePMS, MeHotel, Отеликс, RST PMS, Shelter, TravelLine, Эделинк, HotelPMS, RealtyCalendar** (всего 18+).
- Для CM-вендора, желающего стать сертифицированным: **закрытая программа**, контакт `hotel.partners@support.yandex.ru`, документация по NDA.

### 3.2 Inventory model

- **Per-room-category** (категории, не per-unit).
- **Limit: 20 primary + 8 extra beds** на категорию.
- **Daily grid.**
- **Pooled** (через CM).
- **Apartments**: availability capped at 1 на unit.

### 3.3 Rates model

- BAR-flex и BAR-NR через cancellation policies. **Cancellation policy — обязательное поле**, без неё inventory не передаётся (известный gotcha).
- Restrictions: min/max nights, release period, CTA/CTD.
- **Apartments не могут иметь meal plans** — auto-converts в room-only.
- Currency: RUB. Туристический сбор Сочи 2% — отдельная fee-строка.
- **Geographic constraint:** только accommodations в РФ.

### 3.4 Booking pull

- Через CM: webhook-style, CM получает push от Я.Путешествий о новой брони (closed spec).
- Через Partner API (affiliate, не наш кейс): `GET hotels/booking/orders/{order_id}/status` polling.
- **Cancellation:** `refund/calculate` → cancel order.
- **Idempotency-Key header** (UUID v4) — Yandex Cloud-wide convention.

### 3.5 Errors

Закрытая спека для CM-канала. Affiliate API публикует HTTP-стандарт + domain errors `offer_expired`, `price_changed`, `no_availability`, `payment_failed`, `cancellation_not_allowed`. Rate limits per-token, конкретные числа в публичной документации не раскрыты.

### 3.6 Идиоматика и подводные камни

- **Cancellation policy mandatory.** Domain-level required field.
- **Категории и тарифы передаются один раз при подключении** — новые надо создавать через Extranet.
- **Разделение Partner Network API vs Extranet API** — разные миры, разная авторизация.
- **20+8 лимит beds** — domain validation на нашей стороне.
- **Apartments — отдельный flow.**
- **17% commission + acquiring** — exit-fee model.

---

## 4. Сравнительная таблица

| Параметр | TravelLine | Ostrovok / ETG | Яндекс Путешествия |
|---|---|---|---|
| Тип | CM + PMS + BE | OTA-агрегатор + B2B distribution | OTA + meta-search |
| **Публичный supplier API** | Да | **НЕТ** (только через CM) | **НЕТ** (только через сертиф. CM) |
| Auth | OAuth2 → JWT (15min) | Basic Auth (id+uuid) | OAuth + X-Ya-Session-Key (affiliate) |
| Sandbox | Да | `api-sandbox.worldota.net` | Закрытый, по запросу |
| Inventory granularity | Per-room-type | Pull-based (distributor) | Per-room-category |
| Allocated/Pooled | Pooled | Pooled (на стороне ETG) | Pooled (через CM) |
| BAR-flex / BAR-NR | Да | Да | Да (policy mandatory) |
| Booking model | Polling Read API + Checksum + CreateBookingToken | Webhook ИЛИ status polling | Webhook (CM-channel, closed spec) |
| Idempotency | CreateBookingToken (24h TTL) + Checksum | partner_order_id | Idempotency-Key (UUID) |
| Cancellation | Status flow | Separate endpoint `order/cancel` | refund/calculate → cancel |
| Rate limits | 3/s, 15/min, 300/h | НЕ публичные | НЕ публичные |
| Currency | RUB inclusive VAT | Multi-currency | RUB + tourist tax 2% Sochi |
| Rate parity | Не enforced (CM-side) | OTA-soft (ranking) | OTA-soft + 17% commission |
| XML/JSON | JSON REST | JSON REST | JSON REST (Partner API), CM-channel — closed |
| Sertification | Required, 2-3 days | Account-manager onboarding | **Closed program, NDA для CM** |

---

## 5. Решения для нашего mock

### 5.1 Inventory model: **Pooled**

Pooled выигрывает 2026. Все 3 канала фактически работают через pooled bucket. Domain model: единый `availability(roomTypeId, date, roomsAvailable, version)`. Каждый push-event инкрементит version monotonic.

**Antifragile pattern:** version-based last-write-wins, старый update silently dropped. CDC-outbox → channel-dispatcher.

### 5.2 Sync model: **Hybrid push + webhook + polling reconciliation**

- **Outbound (we → channel):** push (CDC-outbox → dispatcher → channel adapter → channel API). Idempotent commands с `(roomTypeId, date, version)` key.
- **Inbound bookings (channel → us):** **webhook primary**, polling reconciliation **secondary** (every 5 min для ETG, 15 min для Я.П, on-demand pull для TL).
- **Reconciliation pass:** ежечасный full pull последних 24h для всех 3 каналов — catches missed webhooks.

### 5.3 Mock-implementation для каждого

**Все 3 mock-адаптера** соблюдают rate limits, возвращают realistic errors, эмулируют webhook delivery с jitter (50-200ms).

#### TravelLineMockImpl
- OAuth2 token endpoint: возвращает JWT, TTL 15min.
- 5 API products: Content, Search, Read Reservation, PMS Universal, Reviews.
- Hash-checksum валидация на book.
- CreateBookingToken 24h TTL, single-use.
- Rate-limit responses (429 + retry-after) при превышении 3/s или 15/min.
- 5% — domain errors (sold_out, invalid_room).
- 3% — internal_error (retryable 503).

#### OstrovokMockImpl (ETG distribution)
- Search → hotelpage → prebook → book pipeline.
- prebook required (без него book → 422 prebook_required).
- 8% — `price_changed` between search и prebook.
- Hotel ID mapping (ETG hotel_id ≠ наш property ID).
- Static dump endpoints для weekly+daily.
- Webhook subscription для booking status changes.

#### YandexTravelMockImpl
- ⚠️ **Реверс-инжиниринг из Bnovo/Контур.Отель wiki** (supplier API closed).
- 20+8 beds limit на категорию.
- Mandatory cancellation policy.
- Apartments capped at 1 + no meal plans.
- Webhook на booking events.
- 17% commission в income calculation.
- Idempotency-Key UUID v4.

### 5.4 Confidence per channel

| Канал | Confidence | Rationale |
|---|---|---|
| **TravelLine** | High (8/10) | Публичная документация, JWT/OAuth2, 5 API products, sandbox. Открытое: точная schema reservation polling. |
| **Ostrovok / ETG** | Medium-High (7/10) | Postman + 2 official SDK + integration guide публичны. **Distribution API**, не supplier. Для supplier-flow обязателен сертифицированный CM-посредник. |
| **Яндекс Путешествия** | Medium-Low (5/10) | Partner Network API публичен, но это **affiliate**-flow. Hotelier-side — closed spec. NDA-программа для production CM. |

---

## 6. Открытые вопросы (требуют real-integration phase)

1. TravelLine webhook support — есть ли push для bookings или только polling? DevPortal требует logged-in доступа для полной schema.
2. TravelLine точная rate-limit policy для PMS Universal API endpoints.
3. ETG webhook subscription model — формат payload, retry policy, signature verification (HMAC?).
4. Я.Путешествия CM-channel spec — единственный путь = пройти сертификацию + NDA.
5. Я.Путешествия 17% commission — pre-commission цена или post-commission на rate-push? Зависит от типа договора.
6. Туристический налог Сочи 2% — fee-строка отдельная или inclusive? Каждый канал handle по-разному.
7. Cross-channel booking_id mapping — наш internal vs `pmsRoomStayId` (TL), `partner_order_id` (ETG), `order_id` (Y.Travel). Domain mapping table нужен.
8. Apartments vs hotels schema differences в Я.Путешествиях.

---

## 7. Источники (URL + дата 27.04.2026)

**TravelLine:**
- [DevPortal Overview](https://www.travelline.ru/dev-portal/docs/api/)
- [Reservation API Knowledge Base](https://www.travelline.ru/support/knowledge-base/reservation-api-bronirovanie/)
- [Partner API Connection Guide](https://www.travelline.ru/support/knowledge-base/kak-kanalu-prodazh-podklyuchit-partner-api/)
- [Channel Manager Product Page](https://www.travelline.ru/products/channel-manager/)
- [HotelTechReport TravelLine Review 2026](https://hoteltechreport.com/revenue-management/channel-managers/travelline-channel-manager)

**Ostrovok / ETG:**
- [ETG API v3 Docs](https://docs.emergingtravel.com/)
- [Integration Guide](https://docs.emergingtravel.com/docs/integration-guide/)
- [Postman Workspace](https://www.postman.com/ostrovok/emerging-travel-group-s-public-workspace/documentation/x7uz0ty/etg-api-v3)
- [Python SDK](https://github.com/EmergingTravel/papi-sdk-python)
- [PHP SDK](https://github.com/EmergingTravel/papi-sdk-php)
- [Cloudbeds ↔ Ostrovok](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/360005599793-Connecting-myfrontdesk-with-Ostrovok)

**Яндекс Путешествия:**
- [Partner Network API](https://yandex.ru/dev/travel-partners-api/doc/ru/)
- [Booking Overview](https://yandex.ru/dev/travel-partners-api/doc/ru/booking-overview)
- [Подключение через CM](https://yandex.ru/support/travel-partners/ru/extranet-managers)
- [Bnovo ↔ Yandex Travel](https://help.bnovo.ru/knowledgebase/yandex-travel-new-version/)
- [Контур.Отель ↔ Я.Путешествия](https://support.kontur.ru/hotel/44895-yandeks_puteshestviya)

**Общие 2026 patterns:**
- [Cloudbeds Channel Manager Guide 2026](https://www.cloudbeds.com/articles/channel-manager-software-guide/)
- [HotelTechReport: 7 Best Channel Managers 2026](https://hoteltechreport.com/revenue-management/channel-managers)
- [SiteMinder Channel Manager](https://www.siteminder.com/channel-manager/)
- [Booking.com Connectivity Docs](https://developers.booking.com/connectivity/docs)
- [Channex Open Channel API](https://docs.channex.io/for-ota/open-channel-api)
- [STAAH ChannelConnect API](https://getapidoc.staah.net/)
- [Pooled inventory / overbooking guide 2026](https://zuzuhospitality.com/blog/what-is-channel-manager-guide)
- [DMA / Booking.com parity ruling Mar 2026](https://news.booking.com/amsterdam-court-upholds-key-elements-of-bookingcoms-position-in-german-price-parity-case/)
