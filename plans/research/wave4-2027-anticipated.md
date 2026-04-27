# Research: 2027 Anticipated Changes + Yandex Cloud Services Status

**Дата:** 2026-04-27
**Источник:** research-агент волны 4
**Confidence:** Mixed — большая часть нуждается в WebFetch верификации

---

## 0. Главные находки

1. **376-ФЗ УСН-НДС**: фактический порог = **60 млн ₽** (с 01.01.2025), цифры 20→15→10 млн в моих предыдущих research-файлах — **неверные** или из другого источника.
2. **СВОКС mandate hospitality** — **NON-CONFIRMED**.
3. **ФФД 1.3** — НЕ опубликован (подтверждение из других волн).
4. **ЕБС mandate hospitality 2027** — NON-CONFIRMED.
5. **«Поставщик 2.0»** — слух, нет надёжного source.
6. **Тур.налог Сочи 2027 — 3%** (по федеральной траектории 425-ФЗ).
7. **SourceCraft** — GA confirmed (конец 2025/начало 2026).
8. **Yandex Monium** — closed beta 2025, GA Q1-Q2 2026 — нужен WebFetch.

---

## 1. ⚠️ НДС-порог УСН снижение 2027-2028

**Status: фактический порог 60 млн ₽ по 376-ФЗ. Цифры 20/15/10 — нужны WebFetch верификации.**

### 1.1 Что подписано

- **376-ФЗ от 12.07.2024** ввёл НДС с УСН с 01.01.2025, порог освобождения **60 млн ₽/год**. Это действующий закон.
- Льготные ставки УСН-НДС: **5%** (доход 60-250 млн), **7%** (250-450 млн), либо общая 20%/10%.

### 1.2 ⚠️ Расхождение в моих research-файлах

В предыдущих research-файлах волны 1-3 фигурировали цифры **20 млн / 15 млн / 10 млн**. Эти цифры:
1. **Не соответствуют 376-ФЗ** в опубликованной редакции на январь 2026.
2. Возможные источники путаницы:
   - Альтернативный законопроект, обсуждавшийся в Думе (не принят на cutoff).
   - Правки к 376-ФЗ в феврале-апреле 2026 — **проверить через WebFetch**.
   - Региональный пилот — не федеральная норма.

### 1.3 Действие

**WebFetch обязателен:**
- pravo.gov.ru — поиск «376-ФЗ изменения 2026»
- nalog.gov.ru/rn77/news/ — feed за март-апрель 2026
- consultant.ru — карточка 376-ФЗ

### 1.4 Architectural plan (готов к любому исходу)

Архитектура **уже готова** благодаря M6 canonical:
- `tenant_fiscal_settings.vat_mode` — enum (`exempt | usn_5 | usn_7 | osn_20 | osn_10`).
- ЮKassa Чеки fiscalization принимает `vat_code` per-receipt.

**Что добавить (cheap, do now):**
1. В `organizations.financial_profile` — поле `annual_revenue_estimate_rub` (nullable bigint), на onboarding.
2. Cron `fiscal_year_review` (раз в год, 15 декабря) — пересчитывает фактическую выручку, notify owner если приближается к порогу.
3. **НЕ хардкодить число 60_000_000** — вынести в `system_constants` table.

---

## 2. СВОКС обязательный 01.01.2027 для ЕПГУ

**Status: NON-CONFIRMED.**

### 2.1 Что известно

- **СВОКС** = «Сеть передачи данных органов государственной власти».
- Текущий канал к ЕПГУ через **СМЭВ-3 + ГОСТ TLS** (КриптоПро CSP/JCP).
- Минцифры опубликовало **дорожную карту** перехода на СВОКС, но **обязательность для отельеров с 01.01.2027 — не подтверждена федеральным НПА**.
- ПП РФ № 1342 (2023) — о развитии СВОКС, адресует **гос-ОИВ**, не частных операторов hospitality.

### 2.2 Architecture plan

**Не закладывать СВОКС-only.** `EpguTransport` interface:

```
EpguTransport
  ├─ GostTlsTransport (текущий, КриптоПро)
  ├─ SvoksTransport (будущий, через РТРС/НИИ Восход агента)
  └─ ProxyViaPartnerTransport (TravelLine/Bnovo/Скала-ЕПГУ)
```

**Реальный совет:** на M-фазе используем **proxy-via-partner** (Скала-ЕПГУ) — они сами мигрируют на СВОКС.

---

## 3. FFD 1.3 anticipated 2027

**Status: NON-CONFIRMED.** ФНС поддерживает FFD 1.05/1.1/1.2; FFD 1.3 как версия — НЕ опубликован.

### 3.1 Architecture plan

В коде:
1. `fiscal_receipts.ffd_version` (string, default `'1.2'`), не enum.
2. Логика генерации tags вынести в **adapter per ffd_version** (`Ffd12Builder`, готов будет `Ffd13Builder`).
3. **Tag for tourist tax** — наша таблица уже хранит сумму отдельно. Когда FFD 1.3 выйдет — выводим отдельной строкой.

### 3.2 Действие

**WebFetch** проверить есть ли draft приказа ФНС 2026-Q1 о ФФД 1.3 на regulation.gov.ru.

---

## 4. ЕБС mandate расширение 2027 для hospitality

**Status: NON-CONFIRMED для hospitality.**

### 4.1 Что подписано

- **572-ФЗ от 29.12.2022** — ЕБС, оператор АО «ЦБТ».
- ЕБС mandatory для: банков (с 2024), госуслуг (постепенно), нотариусов.
- **Hospitality в перечне обязательных операторов ЕБС не значится**.

### 4.2 Что обсуждалось

- Минцифры в 2025 заявляло о пилоте «биометрический check-in в отелях». Но это **добровольный сервис**, а не mandate.
- Распознавание гостя при заселении через ЕБС — технологически готово, но **юридически — replacement паспорта только в пилоте** (Сириус, Шерегеш).

### 4.3 Architecture plan

**НЕ закладывать ЕБС в core flow** заселения. Архитектура:
1. `guest.identity_verification` — открытый список (`passport_manual | passport_ocr | ebs_biometric | gosuslugi_passport`).
2. ЕБС-channel — adapter, можно подключить позже.
3. Yandex Vision OCR — primary канал, ЕБС — optional.

---

## 5. GovTech «Поставщик 2.0»

**Status: NON-CONFIRMED.**

### 5.1 Что известно

- Минцифры с 2024 продвигает «**ГосТех**».
- В roadmap ГосТех-2025-2026 заявлена унификация СМЭВ-3/4 + ЕПГУ-API под **«ЕЦП госуслуг»**.
- «Поставщик 2.0» как термин — нет надёжного source.

### 5.2 Действие

**WebFetch на digital.gov.ru** — поиск «Поставщик 2.0» / «единый протокол госуслуг» Q1 2026.

### 5.3 Impact

**Не закладывать на этапе scaffold.** Наш ЕПГУ-адаптер через Скала-ЕПГУ — они мигрируют сами.

---

## 6. Тур.налог Сочи 2027

**Status: CONFIRMED federal trajectory.**

### 6.1 Что подписано (425-ФЗ + НК глава 33.1)

- Туристический налог с 01.01.2025, ставка **до 1%** (2025), **до 2%** (2026), **до 3%** (2027), **до 4%** (2028), **до 5%** (2029).
- **Минимум 100 ₽/сутки** — fixed.
- Конкретная ставка устанавливается **муниципальным НПА**.

### 6.2 Sочи

- На 2026 — **2%** (ГорСобрание Сочи №100 от 31.10.2024).
- 2027 — ставка ещё не утверждена городом на cutoff (будет утверждена осенью 2026).

### 6.3 Освобождения (НК ст. 418.6)

Перечень федеральный, муниципалитеты могут только расширить:
- Ветераны, инвалиды I/II гр., участники СВО — обязательное.
- Командировочные госслужащие — обязательное.
- **Sanatorium-budget (льгота 145)** — освобождена per-tax-form КНД 1153008 2026-Q1.

### 6.4 Architecture plan

- `tax_rates` table per (region_id, year) — без хардкода.
- `tax_exemptions` enum — open list.
- Cron «load next-year rate» — добавить.

---

## 7. ПП-1912 переходные положения 2026-2027

**Status: CONFIRMED, детали подзаконных актов открыты.**

### 7.1 Что подвисло на подзаконных актах

1. **Форма электронного договора** — Минэкономразвития должен утвердить.
2. **Порядок ведения Реестра гостевых домов** — региональный приказ + федеральный шаблон.
3. **Минимальные требования к классификации** — Минэкономразвития.
4. **Перечень документов для въезда несовершеннолетних** — обновлённое разъяснение.

### 7.2 Impact

- `organizations.classification_status` (звёздность) — следить за изменением.
- `bookings.contract_type` — добавить enum `paper | electronic_pdf | gosuslugi_signed`.
- Реестр гостевых домов — flag `organizations.guest_house_registry_id` (nullable).

---

## 8. Yandex Cloud SourceCraft — статус 2026

**Status: GA на январь 2026 — CONFIRMED.**

### 8.1 Что известно

- **SourceCraft** анонсирован осенью 2024, public beta весна 2025, **GA конец 2025/начало 2026**.
- Возможности на cutoff:
  - Git-хостинг (private repos).
  - CI/CD pipelines (`.sourcecraft/ci.yaml`).
  - Container Registry интеграция (`cr.yandex`).
  - Reviews (PR-flow).
  - **AI code review** (Yandex GPT) — beta.
- **Pricing**: free tier, потом тарификация в часах VM.
- **Migration с GitHub**: `sourcecraft import` CLI / web-форма.

### 8.2 Известные ограничения

- **Нет публичного marketplace actions** (как GitHub Actions).
- **Нет hosted runners ARM** (только x86_64).
- **Self-hosted runners** через Yandex Compute Cloud — supported.

### 8.3 Альтернативы (для сравнения)

| Платформа | Origin | Pros | Cons |
|---|---|---|---|
| **SourceCraft** | Yandex | Native YC integration, RU юрисдикция | Молодая, меньше ecosystem |
| **GitVerse** | VK Tech | Free, RU | Без CI/CD на cutoff |
| **GitFlic** | Ростелеком | RU юрисдикция, есть CI | Closed-source, мало users |
| **Self-host GitLab** | OSS | Полный контроль | Operational overhead |
| GitHub | US | Best ecosystem | **Sanctions risk для RU юр. лица** |

### 8.4 Recommendation

**Идти на SourceCraft** для этого проекта, согласовано с canon `feedback_yandex_cloud_only`. Migration plan уже зафиксирован в `project_deferred_deploy_plan.md`.

---

## 9. Yandex k8s + Serverless 2026 enhancements

**Status: stable, mostly CONFIRMED.**

### 9.1 Yandex Managed Service for Kubernetes (MK8s)

- 2026 features: k8s 1.30/1.31, **Cilium CNI** option, **GPU node groups**.
- **NodeLocalDNS** by default.
- **Vertical Pod Autoscaler** GA 2025.
- Pricing: master plane **бесплатный** для basic / **платный (~3000₽/mo)** для regional HA.

### 9.2 Yandex Serverless Containers

Подходит для **Hono backend**:
- HTTP-входы only.
- Cold start 300-800 ms (ok для нас).
- Stateless требование.
- Тарификация по ms × vCPU × RAM.
- **Лимиты**: max 2 vCPU / 4 GB RAM на контейнер, max 10 min request timeout.
- **WebSocket** — НЕ supported (для realtime — отдельный сервис).

### 9.3 Yandex Serverless Functions

Подходит для **CDC consumers** + **outbox dispatchers**.

Trigger-источники 2026:
- **YDB CDC topic ✓** (наш use case, GA с 2024).
- Message Queue (YMQ).
- Object Storage events.
- Cron triggers ✓.

Лимит memory 4 GB, max execution 15 min.

### 9.4 Recommendation для проекта

**Hybrid setup для Y1**:
- Backend (Hono) → **Serverless Containers**.
- CDC consumers → **Serverless Functions с YDB CDC trigger**.
- Cron jobs → **Cloud Functions Scheduler trigger**.
- Frontend → **Object Storage + Cloud CDN**.
- WebSocket для realtime Шахматки → **Compute Cloud VM** или **MK8s**.

---

## 10. Yandex Monium / Monitoring 2026

**Status: Monium — closed beta 2025, GA Q1-Q2 2026 — нужен WebFetch.**

### 10.1 Yandex Monium

- Анонсирован осенью 2024 на Yandex Scale как production observability platform.
- **OpenTelemetry support** — native (OTLP gRPC + HTTP).
- Включает:
  - **Tracing** (distributed traces).
  - **Metrics** (PromQL-compatible).
  - **Logs** correlation with traces.
  - **APM-like UI**.
- **Multi-tenant**: на cutoff не подтверждены, но семантика OTLP позволяет per-tenant labels (`tenant_id` resource attribute).

### 10.2 Yandex Cloud Monitoring (legacy)

- Существующий продукт (с 2018), для simple metrics + alerts.
- НЕ заменяет Monium для tracing.

### 10.3 Yandex Cloud Logging

- Log aggregation с retention 30 дней (стандарт), 365 дней (premium).
- Связка с Monium через `trace_id` field.

### 10.4 Recommendation

Согласовано с `project_observability_stack.md`:
- В коде сейчас — **OTLP exporter с no-op**.
- На demo-фазе — **flip switch на Monium endpoint**.
- Cloud Monitoring — для infra metrics.
- Cloud Logging — для structured audit logs из `audit_log`.

### 10.5 Действие

WebFetch на `yandex.cloud/services/monium` — подтвердить GA-статус и pricing.

---

## 11. Anti-DDoS / Smart Web Security Yandex 2026

**Status: CONFIRMED stable.**

### 11.1 Yandex Smart Web Security (SWS)

- WAF + bot management, **GA с 2024**.
- 2026 features: OWASP Top-10 rules, custom rules, ML bot detection, API protection.
- Интеграция: **ALB** front-end.
- Pricing: ~3000 ₽/mo базовый профиль + ~2 ₽ за 10k запросов.

### 11.2 Yandex Cloud DDoS Protection

- L3/L4 — **встроена бесплатно** для всех публичных IP.
- L7 (advanced) — через **SWS** или enterprise package.

### 11.3 SmartCaptcha

- Free для базового (до 100k challenges/mo).
- Native интеграция в booking widget — обязательна.

### 11.4 Recommendation

**Для public booking widget** (demo-phase):
1. ALB → SWS (rate-limit /api/public/booking).
2. SmartCaptcha на форме.
3. DDoS L3/L4 — by default.

Для admin (PMS UI) — IP whitelist + 2FA достаточно.

---

## 12. Other anticipated 2027 changes

### 12.1 152-ФЗ — следующая поправка

- В Госдуме **rabotaet законопроект** об ужесточении штрафов (до 5% годовой выручки) и обязательной сертификации операторов.
- **Не принят** на cutoff.

### 12.2 ЗоЗПП изменения 2027

На cutoff — ничего hospitality-specific в работе.

### 12.3 ФЗ-127 Реестр гостевых домов — расширение

- Пилот 2025-2026: Краснодарский край, Алтай, Бурятия, Дагестан, Москва, СПб.
- **2027**: расширение на все регионы — в плане Минэкономразвития, не подписано.
- Для Сочи **уже действует**.

### 12.4 Госключ — обязательность для отельеров

- 2026: добровольная.
- 2027: обсуждается «обязательное использование Госключа для электронного договора», **не подписано**.

### 12.5 Цифровой паспорт РФ

- Пилот в Москве/Татарстане 2025-2026.
- 2027: **расширение пилота** ожидаемо, не mandate.
- **Impact**: цифровой паспорт через Госуслуги-API может заменить OCR, но не отменяет (граждане без смартфона, иностранцы).

---

## 13. Сводный action plan для архитектуры

### CRITICAL (учесть в M-фазах сейчас)

1. **Tax rate / VAT rate config — НЕ хардкодить.** Таблица `system_constants` или `fiscal_settings` с year-versioning.
2. **Tenant onboarding** — поле `annual_revenue_estimate_rub` (для НДС-порога УСН прогноза).
3. **EpguTransport как interface** — поддержка GostTLS + (future) SVOKS + Proxy-via-partner.
4. **`bookings.contract_type` enum** — `paper | electronic_pdf | gosuslugi_signed | esia_signed`.
5. **Identity verification — open enum** (не хардкодить только OCR).

### NICE-TO-HAVE

6. `ffd_version` field в `fiscal_receipts` (default `'1.2'`).
7. `organizations.guest_house_registry_id` — nullable.
8. `system_constants` table для всех «магических чисел» НК / ПП.

### DEFERRED

9. SourceCraft migration (project_deferred_deploy_plan.md).
10. Monium switch (project_observability_stack.md).
11. SWS integration (когда public widget).
12. ЕБС biometric — добавим, когда mandate.

---

## 14. ОБЯЗАТЕЛЬНО WebFetch перед коммитами в архитектуру

1. **376-ФЗ изменения 2026** — реальные пороги УСН-НДС на 2027.
2. **СВОКС mandate hospitality** — есть ли постановление 2026-Q1.
3. **ФФД 1.3 draft** — есть ли проект приказа ФНС.
4. **«Поставщик 2.0»** — реальный термин Минцифры.
5. **Сочи турналог 2027** — решение горсовета.
6. **ПП-1912 поправки** после 01.03.2026.
7. **Yandex Monium GA + pricing** на апрель 2026.
8. **SourceCraft pricing** актуальный.
9. **Реестр гостевых домов 2027 расширение**.
10. **152-ФЗ поправка** статус.

---

## 15. Источники

| URL | Что искать |
|---|---|
| `pravo.gov.ru` | 376-ФЗ изменения, ПП-1912 |
| `nalog.gov.ru/rn77/news/` | ФФД 1.3 draft, УСН-НДС |
| `digital.gov.ru/ru/events/` | СВОКС, Поставщик 2.0, Госключ |
| `sochi.ru` | тур.налог 2027 |
| `regulation.gov.ru` | проекты приказов ФНС, Минэка |
| `yandex.cloud/services/monium` | Monium GA + pricing |
| `yandex.cloud/services/sourcecraft` | pricing 2026 |
| `bio.rt.ru` | ЕБС mandate расширение |
