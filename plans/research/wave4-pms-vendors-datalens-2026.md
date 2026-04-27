# Research: PMS Vendors + DataLens 2026 release notes (Wave 4)

**Дата:** 2026-04-27
**Источник:** research-агент волны 4 (delta to channel-managers.md + datalens-frontend-stack.md)
**Confidence:** Medium-High

---

## 0. Главные находки

1. **Apaleo Copilot** — VERIFIED 26.03.2026, **agentic layer внутри Apaleo PMS** (не MCP-сервер для внешних AI).
2. **Apaleo MCP Server** — отдельно (alpha с 22.09.2025), capabilities включают write+payment.
3. **Apaleo API changelog** (16.02.2026): pagination limits + Payment Account deprecation (15.05.2026).
4. **Mews $300M raise** на agentic AI — vision, продукт не выпущен.
5. **Mews diffusive overbooking — НЕ пофиксили** (open since 2024).
6. **DataLens Public API запущен** январь 2026 — `https://api.datalens.tech` (IAM tokens).
7. **DataLens v2.8.0 OSS** (10.02.2026) — YDB connector + VIEW support, security fix.
8. **DataLens v2.9.0 OSS** (18.02.2026) — cross-tab global selectors, WYSIWYG.
9. **Booking.com OTA endpoints sunset 31 Dec 2026** — final.
10. **Я.Путешествия комиссия 10%** (extranet, не 17%) — расхождение с моим memory.
11. **NextPax NAPI** — webhook FIFO + smart retry (March 2026).
12. **Cloudbeds CFAR** released Q1 2026.

---

## 1. Apaleo (Q1-Q2 2026)

### 1.1 API Changelog

| Дата | Событие |
|---|---|
| 16.02.2026 | **Pagination limits** — новые client IDs c 15.02.2026, существующие — с 01.04.2026, дополнительные restrictions с 01.11.2026 |
| 16.02.2026 | **Payment Account deprecation** — `paymentAccount` field в `CreateBookingModel`, removal **15.05.2026**. Migrate to new Payment Account APIs |

**Impact**: Apaleo формализует separation «booking ↔ payment account» — совпадает с нашим M6 canonical.

### 1.2 Apaleo Copilot (26.03.2026) — VERIFIED

- **Не MCP-сервер**, а **agentic layer внутри платформы** на Apaleo's open API.
- Tasks: arrivals checking, stay extension, housekeeping, **overbooking resolution**, room assignment.
- Trainable per property/group/brand.
- Поддерживает **A2A (agent-to-agent)** — third-party агенты подключаются.
- Расширение **Agent Hub** (запущен 2025) — marketplace AI-агентов с partners Lobby, Triple, TheNew Group.
- Apaleo blog post «How API-first, MCP, and AI agents are transforming hospitality» — MCP считается частью public messaging.

**Impact на наш differentiator** «PMS с AI-агентом на русском»: USP остаётся валидным (Apaleo не покрывает РФ-специфику: МВД ЕПГУ, 152-ФЗ, ЕГАИС, ОФД, тур.налог 2% Сочи). Но architectural delta уменьшается — закладывать **agent-friendly API + MCP-readiness уже на стадии scaffold**.

### 1.3 Apaleo MCP Server

- Отдельно от Copilot, **alpha с 22.09.2025**.
- Capabilities (declared): read + **modify bookings, check availability, access loyalty info, coordinate housekeeping, process payments**.
- Доступ через «MCP Alpha Group» в Apaleo Community.
- Pricing не публиковалось.

### 1.4 Apaleo €20M growth equity 2026

Funding-новость подтверждена.

---

## 2. Mews (Q1-Q2 2026)

### 2.1 $300M raise (январь 2026)

- На **agentic AI** — vision «agentic orchestration».
- **Продукт не выпущен** — пока roadmap-документ.
- AI-агенты-«цифровые сотрудники» через автономную координацию workflows.

### 2.2 Mews Connector API Changelog

- `Outlet bill`: `AccountId`, `Notes`.
- `Counter` response: `EnterpriseId`; type `AccountingCounter`.
- `TaxExemptionReason` расширен `PL_ZW`, `PL_NP` (польский налог).
- `Rate`, `Product`, `OrderItem` получили `TaxExemptionReason` + `TaxExemptionLegalReference`.
- `BillCompanyData`: `DUNS`, `Telephone`, `TaxIdentifier`, `InvoicingEmail`, `Department`.

**Impact**: Mews активно полирует **fiscal/tax-exemption** layer. Сигнал, что enterprise-tier PMS вынуждены кодировать legal reasons в API — наш RU-аналог должен закладывать `tax_exemption_reason` enum.

### 2.3 Diffusive overbooking — НЕ ПОФИКСИЛИ

Feature request на feedback.mews.com **«push diffusive overbooking strategy to channel manager»** остаётся **open** с 2024 г. Mews PMS блокирует продажу на house level, но channel manager продолжает sell на OTA → реальные overbooking-инциденты.

**Impact**: для нашего scope — положительный delta (мы можем сделать «правильный» overbooking forwarding). Подтверждение зрелости `project_event_architecture.md` (CDC outbox → channel manager push).

### 2.4 Vouchers / credits 2026

- **VoucherCart** запустил Reservation Module для Mews.
- Mews Inner Circle community-program (gamification).

---

## 3. Cloudbeds (Q1-Q2 2026) — VERIFIED

### 3.1 Product updates

| Месяц | Update |
|---|---|
| Jan 2026 | **Consolidated Reporting Navigation** — единый menu для нового Insights builder + legacy Standard reports |
| Jan 2026 | **Calendar Week Start Day** — выбор Sun/Sat/Mon |
| Jan 2026 | **Third-Party Channel Manager Guest Messaging & Reviews** — Airbnb/Expedia через SiteMinder/STAAH |
| Feb 2026 | **Seamless Multi-Reservation Access on Kiosks** — guest с N бронями видит все в одной session |
| Feb 2026 | **Booking.com Rate Plan Management** — create/edit/delete BDC rate plans изнутри Cloudbeds |

### 3.2 Cancel For Any Reason (CFAR) — VERIFIED RELEASED

- «being released in phases, gradually enabled for all eligible Cloudbeds properties through Q1 2026».
- Активируется **только после free-cancellation period**.
- Refunds handled by **HTS** (third-party provider).
- Доступно в 190+ countries.

**Impact**: validating сигнал — паттерн «non-refundable + paid CFAR add-on at booking» жизнеспособен. Залогичивать как future M9-M10 add-on.

### 3.3 Cloudbeds API статус

- **v1.1 deprecated 31.03.2025**.
- **v1.2** — текущий major.
- **v2** — в Python SDK на GitHub, но публичного 2026 release announcement не нашёл.

### 3.4 2026 State of Independent Hotels Report

- 25.03.2026 — 4th annual edition, 90M bookings, 180 countries.
- Marketing intel-paper для нашего sales-позиционирования.

### 3.5 Cloudbeds Signals — AI

«hospitality's first foundation AI model» (causal AI, demand forecasting, pricing).

---

## 4. Yandex DataLens (Q1-Q2 2026)

### 4.1 Cloud DataLens — January 2026 (VERIFIED)

**Features:**
- **Public API запущен** — `https://api.datalens.tech`. OpenAPI-spec, аутентификация через **Yandex Cloud IAM tokens**.
- Покрывает dashboards, charts, datasets, connections.
- Billing account lists показывают аккаунты других организаций.
- **Seat reassignment** — реассайн seat-ов перед expiration.
- Dashboard: selector display control via «Show in tabs», value persistence between tabs, link config для unopened tabs, Mermaid color rendering.

**Bug fixes**: line styles, drag-and-drop в map layer filters, formula editor, stable table render, clipboard.

**Impact**: Public API — серьёзный delta. Можно встраивать в наши workers (programmatic per-tenant dashboard provisioning).

### 4.2 Cloud DataLens — Feb / March / April 2026

**Заблокированы Yandex SmartCaptcha** при WebFetch. Status: not published в индексируемом виде, last verified Jan 2026.

### 4.3 DataLens OSS — VERIFIED

| Версия | Дата | Ключевое |
|---|---|---|
| **v2.8.0** | 10.02.2026 | Hash functions в формулах, **DB_CALL** functions, `ARRAY_DISTINCT`/`ARRAY_INDEX_OF`, **Greenplum 7 support**, **YDB connector VIEW support** + **security fix для YDB DB_CALL vulnerability** |
| **v2.9.0** | 18.02.2026 | Chart axis scaling, connection/dataset descriptions, standard visualizations (replaces d3), range slider gravity charts, **cross-tab global selectors**, WYSIWYG text editor |

**Impact для нас:**
- **YDB connector + VIEW support** (v2.8.0) — критично. До v2.8.0 этот путь был ограничен. Можно инкапсулировать tenant-scope queries в YDB VIEW и подключать DataLens к ним.
- **Cross-tab global selectors** (v2.9.0) — фронт UX upgrade для multi-tab дашбордов.
- **DB_CALL vulnerability fix** на YDB — patch ASAP при self-host пути.

### 4.4 Private Embed JWT — НЕ verified

**Confidence: низкая.** CAPTCHA блок на `private-embedded-objects` page.

Подтверждено:
- В `datalens-tech/datalens-examples` есть directory **`04-How-to-embed-Datalens-into-your-website-using-secure-embedding-technology`** с файлами `main.py`, `serverless_handler.py`, `user_auth.py`, `embed_data_mapping.py`, `agw.yaml.example`. **Это canonical reference implementation.**
- Public-embed (без JWT) работает через URL-параметры `_embedded=1`, `_theme`, `_autoupdate`.
- Yandex Cloud в общем JWT-context использует **PS256** (для IAM tokens).

**Action item**: claim names (`embedId`, `dlEmbedService`, `params`) **подтвердить локальным `git clone https://github.com/datalens-tech/datalens-examples`**. До этого — unverified.

### 4.5 Multi-tenant patterns 2026

Native per-tenant workspace API в DataLens **не подтверждён**. Январский Public API даёт provisioning-кирпичи, но native tenant isolation = строить через комбинацию:
- DataLens Auth (`datalens-tech/datalens-auth`) — кастомизируется.
- Connection-level RLS + per-row filters в DSL.
- Embed JWT с `params` для подмены tenant_id фильтра.

**HoReCa real-world case-study с DataLens — не нашёл.**

---

## 5. Booking.com / Expedia / Я.Путешествия 2026

### 5.1 Booking.com Connectivity API — VERIFIED

**XML deprecation finalized — sunset date 31 December 2026:**

| OTA endpoint | Deprecated | Sunset |
|---|---|---|
| `OTA_HotelDescriptiveContentNotif` (HDCN) | Dec 2024 | **31 Dec 2026** |
| `OTA_HotelSummaryNotif` (HSN) | 31 Dec 2024 | **31 Dec 2026** |
| `OTA_HotelInvNotif` (HIN) | 31 Dec 2024 | **31 Dec 2026** |

**Migration path**: новые **modular APIs** + **Licences API**.

### 5.2 Booking.com VCC

- **VCC Payments Clarity Package 2026** — на extranet/PMS/CM теперь видны activation date, expiration date, balance VCC.
- Refund 60-90 days guided process. Cardholder window — 365 days post-checkout.

### 5.3 Expedia EQC 2026 — VERIFIED

- **Concurrent requests** теперь supported (multiple updates параллельно, но не по одному product+date).
- **2026/27 Connectivity Partner Program** — новые qualification metrics для Elite/Preferred статусов.

### 5.4 Я.Путешествия — Hotelier Extranet

- **Размер комиссии 10%** для отельеров через extranet (НЕ 17% как было в memory).
- Партнёрская программа: до 12% за hotel booking, 2.2% air (для аффилиатов).
- **Расхождение с user mandate**: пользователь упомянул «17% commission». Текущие индексируемые источники — **10% для extranet**.

**Action**: исправить memory `project_initial_framing.md` и channel-managers.md — Я.Путешествия 10%, не 17%.

---

## 6. Channel manager landscape 2026

### 6.1 TravelLine / Bnovo / Channex — release notes

**Не нашёл публичных 2026 release notes.** Status: not published, last seen 2025.

### 6.2 Контур.Отель — VERIFIED

- **Через API ЕПГУ** (Скала-ЕПГУ МВД) — постановка на учёт. API key valid 6 месяцев.
- **Курортный налог tool** — рассчитывает по гостям. **Внимание**: помечено как «курортный сбор», но Сочи 2026 — это туристический налог (отменён курортный сбор). Возможный bug у Контура или устаревшая терминология.

**Impact**: Контур уже закрыл два наших pending: ЕПГУ-интеграция и налог-формы. Они competition-ready.

### 6.3 NextPax — VERIFIED 26.03.2026

| Change | Description |
|---|---|
| **Notifications API (NAPI)** | Webhook real-time delivery, **FIFO**, smart retry. Заменяет polling |
| **Airbnb price recalc** | `exclude_availability_data_from_los_records` flag |
| **Take Over Existing Listings** | Управление existing listings без duplicate (preserves reviews/rankings) |
| **Airbnb Host ID** | Property-level (не account-level) |
| **Minimum Notice Before Booking** | Property-level override Airbnb account-level |
| **Property Reviews API** | backward compat camelCase + snake_case на date fields |

**Impact**: NAPI FIFO+retry — ровно тот pattern что у нас в `project_event_architecture.md`. Validating сигнал.

### 6.4 SiteMinder

API platforms активны, **specific 2026 release-notes deltas не зацепились**.

### 6.5 OTA_HotelDescriptiveContentNotif sunset — 31 Dec 2026

Финальная дата для всех channel managers на legacy XML connection с Booking.com.

---

## 7. Open questions

1. **Точная JWT private-embed схема DataLens** — claim names, signing algorithm, key management. Empirical путь: `git clone https://github.com/datalens-tech/datalens-examples`.
2. **DataLens Feb-Apr 2026 release notes** — заблокированы CAPTCHA.
3. **DataLens HoReCa multi-tenant case-study** — не нашёл.
4. **DataLens pricing рублёвый seat** — за CAPTCHA.
5. **TravelLine, Bnovo, Channex 2026 release notes** — отсутствуют публично. Запросить vendor support.
6. **Я.Путешествия комиссия 10% vs упомянутые 17%** — расхождение, требует уточнения.
7. **Apaleo Reports API / USALI 11th Rev. status 2026** — не проиндексировано.
8. **Mews Operations Reports KPI definitions 2026** — нет публичных deltas.
9. **2027 roadmaps трёх западных вендоров** — нет factory-roadmaps.
10. **Контур.Отель «курортный сбор» в UI vs туристический налог 425-ФЗ** — verify локально.

---

## 8. Sources

- [Apaleo API Changelog](https://apaleo.com/changelog)
- [Apaleo Copilot launch — Hospitality Net (26.03.2026)](https://www.hospitalitynet.org/news/4131640/)
- [Apaleo blog: API-first, MCP, AI agents](https://apaleo.com/blog/industry-trends/api-first-ai-agents-and-mcp)
- [Mews Connector API Changelog](https://mews-systems.gitbook.io/connector-api/changelog)
- [Mews diffusive overbooking forum (open)](https://feedback.mews.com/forums/955688-connectivity/suggestions/46502038-diffusive-overbooking-strategy-also-pushed-to-chan)
- [Cloudbeds Product Updates](https://www.cloudbeds.com/product-updates/)
- [Cloudbeds CFAR overview](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/39033609376411-Cancel-for-Any-Reason-Everything-you-need-to-know)
- [Cloudbeds 2026 Independent Hotels Report](https://www.cloudbeds.com/articles/2026-hotels-report-reveal/)
- [Yandex DataLens release notes (January 2026)](https://yandex.cloud/en/docs/datalens/release-notes/)
- [DataLens GitHub releases](https://github.com/datalens-tech/datalens/releases)
- [DataLens examples (private embed reference)](https://github.com/datalens-tech/datalens-examples)
- [Booking.com Connectivity deprecation policy](https://developers.booking.com/connectivity/docs/deprecation-policy/deprecation-and-sunsetting)
- [Booking.com VCC partner page](https://partner.booking.com/en-us/help/policies-payments/payment-products/everything-you-need-know-about-virtual-credit-cards)
- [Expedia EG Connectivity Hub](https://developers.expediagroup.com/supply/lodging/updates)
- [Я.Путешествия экстранет — Bnovo](https://bnovo.ru/blog/personal-account-in-yandex-travel-new-tool-from-the-leading-online-booking-service/)
- [Контур.Отель — ЕПГУ API news](https://kontur.ru/hotel/news/38547-vozmozhnost_stavit_gostej_na_uchet_v_mvd_cherez_api_epgu)
- [NextPax Supply API updates — March 2026](https://nextpax.com/resources/nextpax-supply-api-updates-march-2026)
