# Research: Notifications + Reference Numbers для Public Booking Widget

**Дата:** 2026-04-27
**Источник:** research-агент волны 3
**Confidence:** High (Yandex Postbox, 38-ФЗ, 152-ФЗ, SMS pricing, nanoid), Medium (Apaleo 8-char ID conventions, quiet hours canon)

---

## 0. TL;DR

- **Reference**: `<TENANT_SLUG>-<NANOID9>` (Crockford-base32 без гласных, без lookalikes), e.g. `RIVIERA-K9M3PXR4T`. Лимит уникальности — per-tenant, индекс — `(tenant_id, reference)`. Просмотр/правка — через **magic-link с подписанным JWT (TTL=15 min на mutation, 30 days на view)**.
- **Notifications**: 7 канонических event'ов. Email — обязателен через **Yandex Postbox**; SMS — только `arrival_day` + `payment_failed` (≈5–8 ₽/штука); push (PWA) — opt-in, Phase 2.

---

## 1. Канонические notification events (2026)

| Event | Trigger | Когда | Email | SMS | Push | RU subject |
|---|---|---|---|---|---|---|
| `booking_confirmed` | Successful payment OR confirmed reservation | Instant (<60s) | yes | no | opt-in | «Бронирование № X — подтверждено» |
| `payment_receipt` | Fiscal receipt issued (54-ФЗ) | Когда чек ОФД готов | yes | no | no | «Кассовый чек по бронированию № X» |
| `pre_arrival` | T−3 days от check-in (Apaleo/Booking.com canon; Mews ставит T−2d/48h) | Cron, 10:00 локально | yes | no | yes | «Скоро ваш отдых: приезд через 3 дня» |
| `arrival_day` | Day-of, T−4h до check-in time | Cron, ≥08:00 локально | yes | yes | yes | «Сегодня ждём вас в {{property_name}}» |
| `post_stay_review` | T+24h от check-out (canon: 2h thank-you → 24h review) | Cron, 11:00 локально | yes | no | no | «Спасибо за визит! Поделитесь впечатлениями» |
| `booking_cancelled` | Cancel SM | Instant | yes | yes (если ≤24h от check-in) | yes | «Бронирование № X отменено» |
| `booking_modified` | Material change | Instant | yes | no | yes | «Изменения в бронировании № X» |
| (опц.) `payment_refunded` | Refund posted | Instant after acquirer ACK | yes | no | no | «Возврат по бронированию № X» |
| (опц.) `payment_failed` | Charge declined | Instant | yes | yes (high-priority) | yes | «Платёж по № X не прошёл» |

---

## 2. Quiet hours / RU compliance

### 2.1 Российский закон

- **Article 18 of 38-ФЗ (О рекламе)**: запрещает рассылку **рекламы** без предварительного согласия абонента; запрещает автоматические массовые рассылки; обязывает **немедленно** прекратить по требованию.
- **Квазивременных ограничений (типа «не позже 21:00») в 38-ФЗ НЕТ** — это US-TCPA-импорт, не RU.
- **152-ФЗ**: согласие на обработку ПД **отдельно** от согласия на рекламу (два чекбокса). Default-unchecked обязательно.

### 2.2 Practical canonical

- `booking_*`, `payment_*`, `pre_arrival`, `arrival_day` = **транзакционные** (исполнение договора по 54-ФЗ + ст. 18 ч. 1 38-ФЗ к ним не применяется).
- `post_stay_review`, любые upsell/marketing — **требуют opt-in согласия** (отдельный чекбокс на форме widget'а).
- **Quiet hours self-imposed canon**: 09:00–21:00 local (Europe/Moscow для Сочи). Применять **только к маркетинговым** — транзакции (cancel/payment_failed) шлём 24/7.

---

## 3. Email design 2026

### 3.1 Технические требования

- **HTML + text fallback** обязателен (без plaintext-альтернативы → spam).
- **Mobile-first**: ≥60% открытий с мобильных, ширина 600px max, single-column, 16px font min.
- **Preheader** (~100 chars): краткая суть для inbox preview.
- **Footer**: реальный почтовый адрес отправителя, unsubscribe-link **только для маркетинга** (RFC 8058 List-Unsubscribe-Post).
- **DKIM/SPF/DMARC**: обязательны все три. Yandex Postbox генерирует DKIM (RSA-2048 или Ed25519).
- **Tracking pixels**: Apple MPP убил open-rate как metric → **link-click** primary engagement metric. Для transactional не ставить pixel.
- **Magic-link** в каждое письмо.
- **ICS attachment**: VEVENT с UID = booking-reference, RFC 5545. Использовать `ics@3.12.0`.
- **Map deep-link**: Yandex.Карты `https://yandex.ru/maps/?ll={{lon}},{{lat}}&z=17&pt={{lon}},{{lat}}`; fallback Google Maps для иностранцев.

### 3.2 Шаблонизация

**Канон 2026 для TS** — **react-email v5.1.0** или **mjml@5.1.9**. Наша система уже на M7.A — оставаться на текущем шаблонизаторе; миграция — отдельная фаза.

---

## 4. SMS templates RU

| Параметр | Значение |
|---|---|
| Длина | **70 chars Cyrillic / 160 Latin** (multi-part: 67/153) |
| Сценарии | `arrival_day`, `payment_failed`, опц. `booking_cancelled` (≤24h) |
| Цена 2026 | **5,55–8,80 ₽/SMS Cyrillic** (sms.ru) |
| Sender ID | Зарегистрированное alpha-имя (бренд) для транзакций |
| Provider canonical | **SMS.ru** (entry, REST API, sender-name registration); SMSC.ru — backup |
| Opt-out | Промо-SMS обязано иметь «Стоп{пробел}{слово}»; транзакции — best-practice |

### 4.1 Шаблоны (≤70 cyrillic chars per segment)

```
arrival_day:
"{{property_short}}: ждём вас сегодня после {{checkin_time}}. Адрес: {{addr_short}}. № {{ref_short}}"

payment_failed:
"Платёж по бронированию № {{ref}} не прошёл. Оплатить: {{magic_url_short}}"

booking_cancelled (only ≤24h):
"Бронирование № {{ref}} в {{property_short}} отменено. Возврат: до 5 дней."
```

---

## 5. Push (PWA Web Push)

- **Canonical**: Web Push API + Push Service worker, VAPID-ключи. Поддержка iOS 16.4+ (только PWA «Add to Home Screen»), Android (всё), Desktop Chrome/Firefox/Edge/Safari.
- **«Yandex.Mobile Push»** — это AppMetrica для нативных приложений, не для PWA. Используем стандартный Web Push.
- **152-ФЗ**: явный opt-in (отдельный чекбокс «Получать пуши» перед `Notification.requestPermission()`).
- **Рекомендация**: **Phase 2**. На MVP оставляем email + SMS.

---

## 6. Notification preferences

```
notification_preferences (
  tenant_id, email, marketing_email_opt_in (default false),
  marketing_sms_opt_in (default false), transactional_email (always true),
  transactional_sms_opt_in, locale, created_at, updated_at
)
```

Per-`guest_email`, не per-booking.
Unsubscribe-token signed JWT (HS256, secret per-tenant), 1-click POST endpoint (RFC 8058).

---

## 7. Multi-language

- **Detection**: `Accept-Language` header при создании booking → сохраняем `guest.locale`. Fallback — telephone country code.
- **Storage**: `notification_template (tenant_id, event, locale, channel)` PK; `locale ∈ {ru, en}`.
- **Сочи canon**: RU primary, EN secondary (~10-15% inbound).

---

## 8. Yandex Postbox specifics 2026

- **Free tier**: 2 000 emails/мес.
- **Discounts**: при объёме >500k/мес — половина прайса.
- **Capacity**: до 10M писем/день.
- **Compliance**: 152-ФЗ, ISO, PCI DSS, ГОСТ Р 57580.
- **Two integration paths**: SMTP **или** AWS SES-compatible API.
- **Sender identity**: домен должен быть верифицирован (DNS TXT + DKIM CNAME).
- **DKIM**: RSA-2048 или Ed25519 (Yandex Postbox генерирует и хостит).
- **Median send time**: <3 s. SLA 99,9% delivery.
- **Production access**: новые аккаунты в sandbox — отправка только на верифицированные адреса.

---

## 9. Failure handling

- **Bounce hard** (5xx SMTP): мгновенно в suppression list, retry NEVER.
- **Bounce soft** (4xx, mailbox full, greylist): 3 retries с exponential backoff (1m, 5m, 30m), затем suppression.
- **Complaint** (recipient marked spam): suppression + alert оператору отеля.
- **Suppression list**: per-tenant table `email_suppression (tenant_id, email, reason, created_at)`. Перед отправкой — `LEFT JOIN` проверка.
- **Postbox events**: подписаться на Yandex Cloud Logging stream `bounce`/`complaint` → CDC в нашу suppression-таблицу.

---

## 10. Канонические шаблоны (RU, 7 штук)

### 10.1 `booking_confirmed` (email)

```
Subject: Бронирование № {{reference}} в {{property_name}} — подтверждено
Preheader: Заезд {{checkin_date_long}}, выезд {{checkout_date_long}}, {{nights}} ночей

Здравствуйте, {{guest_first_name}}!

Бронирование подтверждено.

Номер брони: {{reference}}
Заезд: {{checkin_date_long}} с {{checkin_time}}
Выезд: {{checkout_date_long}} до {{checkout_time}}
Гостей: {{adults}} взр. {{#if children}}+ {{children}} реб.{{/if}}
Категория: {{room_type_name}}
Тариф: {{rate_plan_name}}
Сумма: {{total_amount_formatted}}

{{#if payment_paid}}Оплата получена. Чек придёт отдельным письмом.{{else}}Оплата при заезде.{{/if}}

Управлять бронированием: {{magic_url}}
Адрес: {{property_address}} ({{yandex_maps_link}})

С уважением, {{property_name}}
{{property_phone}} · {{property_email}}

[ICS attached: booking-{{reference}}.ics]

—
Это служебное сообщение по вашему бронированию. Отписаться от маркетинговых писем: {{unsubscribe_url}}.
```

### 10.2 `payment_receipt` (email, fiscal)

```
Subject: Кассовый чек по бронированию № {{reference}}
Preheader: Чек ОФД от {{fiscal_date}}, сумма {{total_amount_formatted}}

Здравствуйте!

Прикладываем кассовый чек по бронированию № {{reference}}.

Дата: {{fiscal_date}}
Сумма: {{total_amount_formatted}}
ФН: {{fn_number}} · ФД: {{fd_number}} · ФП: {{fpd}}
Ссылка ОФД: {{ofd_url}}

[чек.pdf attached]

С уважением, {{property_legal_name}}
ИНН {{property_inn}}
```

### 10.3 `pre_arrival` (email, T−3d, 10:00)

```
Subject: Скоро ваш отдых в {{property_name}} — заезд через 3 дня
Preheader: Адрес, как добраться, время заезда

Здравствуйте, {{guest_first_name}}!

Через 3 дня ждём вас в {{property_name}}.

Заезд: {{checkin_date_long}} с {{checkin_time}}
Адрес: {{property_address}}
Карта: {{yandex_maps_link}}
Как добраться: {{travel_instructions}}

{{#if has_online_checkin}}
Онлайн-регистрация — сэкономит ~10 минут на стойке: {{online_checkin_url}}
{{/if}}

Документы: паспорт РФ или загранпаспорт (по 109-ФЗ).

Контакты: {{property_phone}}, чат {{whatsapp_url}}

До встречи!
{{property_name}}
```

### 10.4 `arrival_day` (email + SMS)

```
Subject: Сегодня ждём вас в {{property_name}}
Preheader: Заезд с {{checkin_time}}, адрес {{property_address_short}}

Здравствуйте, {{guest_first_name}}!

Сегодня ваш день заезда.

Заезд: с {{checkin_time}}
Адрес: {{property_address}} ({{yandex_maps_link}})
Контакт ресепшена: {{property_phone}}

{{#if early_checkin_available}}Ранний заезд возможен с {{early_checkin_time}} (+{{early_checkin_fee}} ₽).{{/if}}

Бронирование: № {{reference}} ({{magic_url}})
```

### 10.5 `post_stay_review` (email, T+24h, 11:00)

```
Subject: Спасибо за визит, {{guest_first_name}}! Поделитесь впечатлениями

Здравствуйте, {{guest_first_name}}!

Спасибо, что выбрали {{property_name}}. Надеемся, отдых удался.

Если у вас есть пара минут — оставьте отзыв:
→ {{review_url}}
{{#if yandex_travel_listing}}
→ Яндекс.Путешествия: {{yandex_travel_url}}
{{/if}}

Ваше мнение помогает нам становиться лучше.

С уважением, {{property_name}}

—
Это маркетинговое письмо. Отписаться: {{unsubscribe_url}}.
```

**Важно**: требует opt-in. Если `marketing_email_opt_in=false` — не отправляем.

### 10.6 `booking_cancelled` (email)

```
Subject: Бронирование № {{reference}} в {{property_name}} отменено
Preheader: Возврат {{refund_amount_formatted}} в течение {{refund_eta_days}} дней

Здравствуйте, {{guest_first_name}}!

Подтверждаем отмену бронирования № {{reference}}.

Заезд: {{checkin_date_long}} ({{nights}} ночей)
Сумма: {{total_amount_formatted}}
{{#if cancellation_fee}}Удержание: {{cancellation_fee_formatted}} ({{cancellation_policy}}){{/if}}
Возврат: {{refund_amount_formatted}} — поступит в течение {{refund_eta_days}} рабочих дней.

Будем рады видеть вас в другой раз: {{property_url}}
```

### 10.7 `booking_modified` (email)

```
Subject: Изменения в бронировании № {{reference}}
Preheader: {{modification_summary}}

Здравствуйте, {{guest_first_name}}!

В бронировании № {{reference}} внесены изменения:

{{#each changes}}
- {{field_label}}: {{old_value}} → {{new_value}}
{{/each}}

Новая сумма: {{total_amount_formatted}}
{{#if surcharge}}Доплата: {{surcharge_formatted}} — {{payment_url}}{{/if}}
{{#if refund}}Возврат: {{refund_formatted}} в течение {{refund_eta_days}} дней.{{/if}}

Управлять бронированием: {{magic_url}}
```

---

## 11. Reference Number Generation

### 11.1 Канонические форматы (industry survey 2026)

| PMS / OTA | Формат | Длина | Примеры |
|---|---|---|---|
| Apaleo | UPPERCASE alphanumeric | 8 chars | `KYKXKLWL` |
| Mews | mixed alphanumeric | ~12 | по доке не публикует |
| Booking.com | numeric | 10 digits | `1234567890` (+ separate PIN) |
| Hilton/Marriott | LETTER+digits | 7-9 | `H1234567` |
| Airline PNR | UPPERCASE alphanumeric | **6** | `A1B2C3` |

### 11.2 Required properties

| Property | Зачем | Наш выбор |
|---|---|---|
| Memorable | Гость диктует по телефону | да — no-lookalikes alphabet |
| Unique | Collision-resistance | per-tenant unique, ~10^14 space |
| Tenant-scoped | Tenant1 не видит ID Tenant2 | UNIQUE(tenant_id, reference) |
| Sortable | Admin search by date | **нет** — leakуется PII (booking volume) |
| URL-safe | В magic-link | да |
| Brute-force resistant | Гость с ref+email manage | reference недостаточен; нужен JWT |
| Spoken-friendly | Дикция по телефону | uppercase only, без vowels |

### 11.3 Recommendation

```ts
// packages/shared/src/id/booking-reference.ts
import { customAlphabet } from 'nanoid';

// 20 chars uppercase, no vowels (no obscene), no 0/1/O/I/L/S/Z/2/5/U/V/A/E
const ALPHABET = '6789BCDFGHJKLMNPQRTW';
const generateRefSuffix = customAlphabet(ALPHABET, 9);

export function generateBookingReference(tenantSlug: string): string {
  // tenantSlug uppercase ASCII, max 8 chars (validated at tenant creation)
  // suffix: 20^9 ≈ 5.12 × 10^11 ≈ 512 billion combos
  return `${tenantSlug.toUpperCase()}-${generateRefSuffix()}`;
}
```

**Length = 9 + tenant slug**:
- 9 random chars: birthday-paradox 1% collision на ~3M записей; UNIQUE check ловит остальное.
- + slug = ~13–17 chars total. Spoken: «РИВЬЕРА — К-9-М-3-П-Х-Р-4-Т» (~10 sec).

**Tenant slug**: храним поле `tenant.public_slug` — обязательное, ASCII uppercase, 3–8 chars, regex `^[A-Z][A-Z0-9]{2,7}$`.

### 11.4 Brute-force protection

**Reference в URL — недостаточно**.

1. **Magic-link с signed JWT**:
   - JWT payload: `{ booking_id, tenant_id, scope: 'view'|'mutate', exp }`
   - HS256 подпись с per-tenant secret (rotatable).
   - TTL: `view` = 30 дней, `mutate` = 15 минут.
   - On click → server verify JWT → set short-lived session cookie → redirect.
2. **Reference + email** (fallback если потерял email-link):
   - `POST /api/public/booking/find { reference, email }` — обе case-insensitive trim.
   - Rate-limit per IP: **10 req/min**, per email: **5 req/hour**, per reference: **3 req/hour**.
   - После 3 fails — captcha (Yandex SmartCaptcha).
   - **Никогда** не выдавать `404 reference not found` vs `403 wrong email` — same response time + same body.
   - Success → отправить **новый magic-link** на email (не выдать токен на странице).
3. **CDC log**: каждая попытка `find` → `audit_log` → SOC dashboard.

### 11.5 Privacy

- Reference в email-magic-link — **не должно** быть достаточно для access. Magic-link с **opaque JWT в path** (`/b/<jwt>`), reference раскрываем в HTML после auth.
- При first click — set HttpOnly cookie + invalidate JWT (so JWT useless if leaked).

### 11.6 Display rules

- **Email subject**: `№ KYKXKLWL` (только suffix).
- **Email body**: full `RIVIERA-K9M3PXR4T`.
- **SMS**: short form, suffix only, ≤9 chars.
- **Voice support**: оператор спрашивает «номер брони» → диктовка по буквам.
- **NEVER** encode date в reference — leaks creation time, помогает enumeration.

---

## 12. Открытые вопросы

1. **Tenant public_slug uniqueness** — global ASCII-uppercase 3-8 chars, validated на org creation в Better Auth `afterCreateOrganization` hook.
2. **Email тип отправителя**: `noreply@booking.<our-saas-domain>` (single-tenant brand) vs `noreply@<tenant-property-domain>` (white-label). MVP: всем `noreply@<our-saas>`.
3. **JWT secret rotation** — частота? Per-tenant secret, rotation каждые 90 дней + grace-period 30 дней.
4. **Inbound MX**: Yandex Postbox — outbound only. Для replies — Mail.ru for Business / Yandex 360.
5. **Push в Сафари iOS**: PWA-only поддерживает iOS 16.4+, требует «Add to Home Screen». На MVP виджета не объявлять support iOS push.
6. **Captcha**: Yandex SmartCaptcha vs hCaptcha — Yandex в коробке, бесплатный до лимита.
7. **SMSC ($29 + $13/template) vs SMS.ru** — SMS.ru: unified billing + sender-id registration в одном кабинете + REST API. SMSC — backup.

---

## 13. Action items для следующих фаз

1. **Schema** — `notification_preferences`; `email_suppression`; `magic_link_jwt_secret per tenant`.
2. **Booking-reference helper** в `packages/shared/src/id/` + UNIQUE(tenant_id, reference) constraint; `tenant_public_slug` field + validator.
3. **7 templates** для public guest — RU локаль, react-email или extension существующего шаблонизатора.
4. **Magic-link service** — JWT issue/verify + rate-limited `find by ref+email` endpoint + Yandex SmartCaptcha integration.
5. **Cron jobs** — `pre_arrival_T-3d`, `arrival_day`, `post_stay_review_T+24h`.
6. **SMS provider adapter** — SMS.ru REST API, sender-name registration flow, suppression list.
7. **Bounce/complaint handler** — подписка на Yandex Cloud Logging stream от Postbox → suppression CDC.

---

## 14. Источники

**Notifications:**
- [Yandex Cloud Postbox](https://yandex.cloud/en/services/postbox)
- [Yandex Postbox quickstart docs](https://github.com/yandex-cloud/docs/blob/master/en/postbox/quickstart.md)
- [38-ФЗ ст. 18 (КонсультантПлюс)](https://www.consultant.ru/document/cons_doc_LAW_58968/f892dec1383709792452f18d36e7043306e2be0a/)
- [Apaleo Pre-stay developer guide](https://apaleo.dev/guides/business-cases/guest-journey/pre-stay.html)
- [Mews — pre-arrival email](https://www.mews.com/en/blog/hotel-pre-arrival-emails)
- [SMS.ru pricing](https://sms.ru/price)
- [DigitalGuest post-stay templates](https://digitalguest.com/post-stay-email-templates/)
- [Litmus Apple MPP](https://www.litmus.com/blog/apple-mail-privacy-protection-for-marketers)

**Reference number:**
- [nanoid (npm 5.1.9)](https://github.com/ai/nanoid)
- [nanoid-dictionary alphabets](https://github.com/CyberAP/nanoid-dictionary)
- [Apaleo Booking API spec](https://api.apaleo.com/swagger/index.html?urls.primaryName=Booking+V1)
- [iCal/ics RFC 5545](https://gist.github.com/superjojo140/20b1b5362ef5700de82a1a3f6ee299ff)
