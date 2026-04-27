# Research: Payment Providers RU April 2026 Delta

**Дата:** 2026-04-27
**Источник:** research-агент волны 4 (delta to yookassa-54fz.md)
**Confidence:** High

---

## 0. Главные находки

1. **YooKassa changelog 24-27.04.2026** — НОВЫХ записей НЕТ.
2. **Yandex Pay = wallet-button**, НЕ acquirer. YooKassa остаётся primary.
3. **YooKassa = ЮMoney НКО = часть Yandex group** — текущий выбор уже native.
4. **CloudPayments = T-Bank Group 95%** (с 2019) — operationally merged 2026.
5. **YooMoney с 29.12.2025 не делает выплаты самозанятым** — для НПД нужен Robokassa SMZ.
6. **СБП ИНН в payload с 01.07.2026** — обязательно.
7. **СБП Подписка 2026 GA** — 200+ банков.
8. **ФФД 1.3 в 2026 НЕ объявлен**.
9. **YooKassa Partner API использует OAuth 2.0** (5-летние токены) — multi-tenant SaaS pattern.

---

## 1. YooKassa changelog апрель 2026 (полный)

| Дата | Изменение |
|---|---|
| 23.04.2026 | «Плати частями» (`sber_bnpl`): max single payment 150k → **50k ₽**, доступен только 2-month term |
| 21.04.2026 | Чеки от ЮKassa: новое значение `yoo_receipt` в `fiscalization.provider` (Me object) |
| 13.04.2026 | Виджет показывает success-page после успешного платежа |
| 07.04.2026 | Payout SBP: новый параметр `sbp_operation_id` в `payout_destination` |

**Pre-April 2026 контекст:**
- 27.03.2026 — лимит чеков на платёж/возврат 30 → **50**.
- 20.03.2026 — фильтр payouts по `succeeded_at`.
- 18.03.2026 — `payment_subject` пополнен значениями `excise`, `marked_excise`, `non_marked_excise`.
- 01.01.2026 — НДС 20%→**22%**, новые `vat_code` 11 и 12. Комиссия выплат включает 22% НДС, добавлены `commissionVat*` поля.
- **29.12.2025 — YooMoney прекратил выплаты самозанятым**.

---

## 2. Yandex Pay 2026 — landscape

### 2.1 Главный вывод

**Yandex Pay в 2026 — это payment method / wallet-кнопка, а НЕ полноценный acquirer.** Это слой поверх existing эквайринга мерчанта (модель Apple Pay / Google Pay).

### 2.2 Доказательства «button-not-acquirer»

- `pay.yandex.ru/docs/en/custom/` явно описывает Yandex Pay как «payment method» интегрированный в чекаут мерчанта.
- `pay.yandex.ru/business` (категории Онлайн, Авто, Электроника, Фэшн, Фитнес) **не упоминает HoReCa/гостиницы**.
- Merchant API состоит из **order**, **operation**, **subscriptions** — **нет refund/capture/3DS endpoints** как у настоящего acquiring API.
- Сторонние интеграторы описывают Yandex Pay как payment method для подключения **через свою онлайн-кассу/acquiring партнёра**.
- YooKassa changelog 21.04.2026 ввёл `yoo_receipt` именно потому что Yandex Pay-платежи фискализируются через ЮKassa Чеки.

### 2.3 Что Yandex Pay API реально умеет

| Возможность | Yandex Pay API |
|---|---|
| Auth | API-Key в `Authorization: Api-Key <key>` |
| Sandbox | `api_key == merchant_id` |
| Order create / render | да (`/order/render`, `/order/create`) |
| **Subscriptions** | **да** — `intervalUnit`, `intervalCount`, `futureWriteOffAmount`, `isBinding`, статусы NEW/ACTIVE/CANCELLED/EXPIRED |
| Refunds/Captures | через `operation` group (детали не extractable) |
| Webhook signature | verification есть, точный алгоритм в публичных docs не выгружен |
| 54-ФЗ | **через внешний фискалайзер** (ЮKassa Чеки, Атол) — не встроено |
| СБП поддержка | в API overview не упомянута — через банк-партнёра |

### 2.4 Когда выбирать

**Только** как дополнительный метод в чекауте YooKassa или своего acquirer. Brand-recognition + конверсия для пользователей Яндекс-экосистемы.

---

## 3. T-Bank Acquiring 2026

### 3.1 Тарифы (verified)

**Package scheme**:

| Тариф | Месячная плата | Пакет | Эфф. ставка |
|---|---|---|---|
| Простой | 1990 ₽ | 100k ₽ оборота | от 1.99% |
| Продвинутый | 2690 ₽ | 150k ₽ | от 1.79% |
| Профессиональный | 3990 ₽ | 250k ₽ | от 1.59% |

**% scheme**:
- Простой 2.69% / Продвинутый 2.29% / Профессиональный 1.79%.
- **СБП QR**: 0.2-0.7% (зависит от MCC).
- Промо до 02.04.2026 (истекло): 0.99% постоянно.
- **+22% НДС** на комиссию (с 01.01.2026).

### 3.2 API features

- Base URL: `https://securepay.tinkoff.ru/v2`.
- Двухстадийный платёж (Init + Confirm), 3DS v1.0 + v2.1.
- **Recurring**: `chargeRecurrent()` с `RebillId`; четыре типа COF — CIT, MIT Recurring, MIT Installment, MIT Delayed-Charge.
- **СБП**: `chargeQr()` + `addAccount()` с `AccountToken` для SBP-автоплатежей. **T-Bank поддерживает СБП-recurring**.
- **Webhook signature**: token-based. Точный алгоритм (HMAC-SHA256 vs SHA256-concat + Password) — empirical verify нужен.
- **54-ФЗ**: через CloudKassir или внешний OFD.

### 3.3 CloudPayments = T-Bank Group 95% (с 2019)

Operationally merged в 2026, executive-leadership объединено. Дублирующая интеграция. **Memory M6 «отказались от CloudPayments» подтверждается**.

---

## 4. СБП 2026 enhancements

### 4.1 Регуляторные изменения

- **01.05.2026** — переводы B2B и C2B становятся **платными** для бизнеса; C2C остаются бесплатными до 100k ₽/мес.
- **01.07.2026** — обязательное указание **ИНН** отправителя/получателя для всех переводов СБП. **Schema impact**: webhooks/payouts будут содержать ИНН поля; **не делать INN nullable жёстко**.
- **01.09.2026** — Росфинмониторинг получает прямой доступ к СБП через НСПК.

### 4.2 СБП Подписка / recurring (verified)

- **2026 GA**: 200+ банков-участников НСПК.
- Управление в банковском приложении («Подписки и автоплатежи»), **client-side cancel**.
- **0% комиссии** для физлиц; для бизнеса — 0.2-0.7% на С2В QR.
- **Merchant-facing API НСПК публично НЕ опубликован** — интеграция через банк-эквайер (T-Bank `addAccount()`) или PSP (YooKassa `payment_method=sbp` + `save_payment_method`).

### 4.3 СБП через YooKassa в 2026

В 2026 году YooKassa добавила СБП в список методов с **unconditional saving для recurring**. Поддерживаемый список: YooMoney wallet, банк. карта, Mir Pay, SberPay, T-Pay, **СБП**. Тариф «Рассчитаем индивидуально».

---

## 5. Альтернативная фискализация 2026

### 5.1 Cloud-кассы рейтинг 2026

| Сервис | Балл |
|---|---|
| **OFD.ru Ferma** | 41.5 (лидер 2026) |
| Комтет Касса | 34.5 |
| **АТОЛ Онлайн** | 31 (от 1733 ₽/мес) |
| Бизнес.Ру Онлайн-Чеки | — |

### 5.2 ЮKassa Чеки (yoo_receipt)

- **С 21.04.2026** — full GA.
- Pro: тот же merchant-онбординг что и YooKassa.
- Con: завязка на YooKassa-как-PSP.

### 5.3 «Мой налог» API (НПД самозанятых)

- **Прямой публичный API ФНС НЕТ** — только через статус «партнёра ФНС».
- **Robokassa Robocheki SMZ** — готовое решение: подключается к ЛК «Мой налог», авточеки на каждый платёж.
- **Reverse-engineered API** (loolzaaa/mytax-client) — **запрещено** для prod.
- **Mandarin** — отдельный платёжный шлюз с НПД-flow.

**Recommendation для гостевых домов на НПД**: **Robokassa SMZ как secondary provider** в `PaymentProviderFactory`.

### 5.4 ФФД статус 2026

- В обороте версии **1.05, 1.1, 1.2** (все три актуальны).
- **ФФД 1.3 в публичных источниках 2026 НЕ существует**. Не закладывать в roadmap.
- 01.09.2025 — приказ ЕД-7-20/236@: связка чек ↔ markings.
- 01.01.2026 — `vat_code` пополнен значениями для НДС 22% и 22/122.

---

## 6. Multi-tenant SaaS payment architecture 2026 RU

### 6.1 YooKassa Partner API / Solutions for Platforms

- Программа «Решения для маркетплейсов и платформ» с **OAuth 2.0**.
- Пользователь редиректится на `https://yookassa.ru/oauth/v2/authorize`, токены **5 лет**.
- Два механизма:
  - **Сплитование платежей** — платформа получает деньги, потом распределяет.
  - **Безопасная сделка** — escrow.
- **Per-tenant** при OAuth-flow: shop_id мерчанта-арендатора + токен. Каждый арендатор — свой shop, свой 54-ФЗ договор.
- Money flow: **деньги напрямую** на расчётный счёт арендатора, не через нас.

### 6.2 Tenant onboarding с 54-ФЗ

Каждый мерчант (= наш tenant) обязан:
- **КЭП** руководителя для подписания договора с ОФД и YooKassa.
- **ИНН + ОГРН/ОГРНИП**.
- **Договор с ОФД** (если cloud-касса вшита в YooKassa Чеки — договор делегирован).
- **Расчётный счёт** в любом банке РФ.
- Activation YooKassa: от 1 дня при OAuth-flow.

---

## 7. Critical decisions

### 7.1 Yandex Pay vs YooKassa для Sochi V1

**YooKassa остаётся primary, Yandex Pay — payment method внутри YooKassa-чекаута.** Yandex Pay не предоставляет acquiring.

**User вопрос «всё ли стек native?» — ответ: ДА.** YooKassa = ЮMoney НКО = часть Yandex-экосистемы.

### 7.2 T-Bank как secondary в PaymentProviderFactory

**Оставить на Phase 2-3.** Аргументы:
- Тарифы 1.59-2.69% сопоставимы.
- API богаче (двухстадийный, recurring через RebillId, СБП-binding).
- Webhook signature алгоритм — отличается от YooKassa, отдельный adapter в `PaymentProviderFactory`.
- НЕ бросать сейчас — нет MVP-блокера.

### 7.3 CloudPayments — отказ подтверждён

T-Bank владеет 95%, операционно слилось. Не возвращаемся.

### 7.4 СБП recurring 2026 — кто поддерживает

- **YooKassa**: ✅ GA, СБП в списке unconditional-saving.
- **T-Bank**: ✅ через `addAccount()` + `chargeQr()`.
- **Yandex Pay**: subscriptions API существует, СБП через банк-партнёра.

### 7.5 Финальная архитектурная рекомендация для M6+

```
PaymentProviderFactory:
  primary:   YooKassa  (PSP + Чеки, СБП, recurring, OAuth multi-tenant)
  fallback:  Stub      (M6 demo phase)
  phase2:    T-Bank    (для tenants с лучшим acquiring deal)
  payment_methods_within_YooKassa:
    - bank_card
    - sbp                       (recurring ✅ since 2026)
    - sber_pay
    - t_pay
    - mir_pay
    - yandex_pay                (button method, fiscalized via yoo_receipt)
    - yoo_money
  fiscalization:
    - yoo_receipt (default since 21.04.2026)
    - external_atol (для tenants с своим АТОЛ)
  npd_self_employed:
    - phase 2: Robokassa Robocheki SMZ adapter
                (НЕ reverse-eng мой-налог API)
```

---

## 8. Что обновить в memory после ресерча

1. **YooKassa changelog апрель 2026** — все 4 записи.
2. **СБП регуляторика 2026**: 01.05 (B2B платно), 01.07 (ИНН в payload), 01.09 (РФМ).
3. **Yandex Pay позиционирование**: payment method, НЕ acquirer.
4. **CloudPayments = T-Bank Group 95%** (не отдельная альтернатива).
5. **ФФД 1.3 в 2026 не анонсирован** — убрать «anticipated 2027».
6. **YooMoney с 29.12.2025 не делает выплаты СМЗ** — для НПД нужен Robokassa SMZ.
7. **YooKassa Partner API OAuth 2.0**, токен 5 лет — multi-tenant модель.

---

## 9. Open empirical TODO

1. `curl -X POST https://securepay.tinkoff.ru/v2/Init` в sandbox + verify webhook signature.
2. Проверить через YooKassa support: поддерживает ли onboarding **самозанятого** (НПД) в 2026.
3. Эмпирически verify, что в `payment.payment_method_data` для метода `yandex_pay` поле `fiscalization.provider` принимает `yoo_receipt`.

---

## 10. Источники

**YooKassa:**
- [YooKassa changelog](https://yookassa.ru/developers/using-api/changelog) — fetched 27.04.2026
- [YooKassa Partner API migration](https://yookassa.ru/developers/solutions-for-platforms/partners-api/migration)
- [YooKassa регулярные платежи](https://yookassa.ru/regulyarnye-platezhi/)

**Yandex Pay:**
- [Yandex Pay API overview EN](https://pay.yandex.ru/docs/en/custom/backend/yandex-pay-api/)
- [Yandex Pay merchant console](https://pay.yandex.ru/docs/en/console/)
- [Yandex Pay business landing](https://pay.yandex.ru/business)

**T-Bank:**
- [T-Bank acquiring tariffs](https://www.tbank.ru/business/help/business-payments/acquiring/about-and-tariffs/pay/)
- [T-Bank E-Acquiring API root](https://developer.tbank.ru/eacq/api)
- [esurkov1/tbank-payments GitHub](https://github.com/esurkov1/tbank-payments)

**СБП:**
- [НСПК подписка СБП](https://sbp.nspk.ru/blog/podpiska-sbp-cto-eto)
- [Свое дело: 1 июля 2026 ИНН в СБП](https://svoedeloplus.ru/2026/04/12/s-1-iyulya-2026-izmeneniya-v-sisteme-bystryh-platezhej-sbp/)
- [hi-tech.mail.ru: 1 мая 2026 платные С2В](https://hi-tech.mail.ru/news/146471-platnye-perevody-po-sbp-s-1-maya-skolko-stoyat-perevody-v-2026-godu/)

**Фискализация:**
- [klerk: рейтинг cloud-касс 2026](https://www.klerk.ru/buh/articles/682027/)
- [astral.ru ФФД 1.05 в 2026](https://astral.ru/aj/elem/ffd-1-05-opredelenie-svoystva-i-kak-ego-ispolzovat/)

**Мой налог / НПД:**
- [Robokassa Robocheki SMZ](https://robokassa.com/online-check/robocheck-smz/)
- [Mandarin самозанятые API](https://docs.mandarin.io/public/api_self-employed.html)

**CloudPayments / T-Bank Group:**
- [Crunchbase: Tinkoff acquired CloudPayments](https://www.crunchbase.com/acquisition/tinkoff-acquires-cloudpayments--fd6422c3)
