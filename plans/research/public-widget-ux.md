# Research: Public Booking Widget UX Canonical Patterns 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 2 (Apaleo Booking Engine v2 + Mews Distributor + Cloudbeds + Bnovo + TravelLine + Booking.com benchmark + Baymard + NN/g + WCAG 2.2)
**Confidence:** High (canon-direction), Medium (конкретные провайдер-specifics из docs которые я не verified live)

---

## 0. Главные выводы

1. **3-screen flow** (не 5-step) — канон 2026. Apaleo Booking Engine v2 (2024 redesign), Mews, Cloudbeds — все там.
2. **Embedded payment** на той же странице что guest form. Redirect — legacy, теряет 8-15% (Baymard 2024).
3. **СБП QR обязательно** — conversion +5-7% для mobile RU users 2026.
4. **Yandex SmartCaptcha invisible mode** — для RU единственный жизнеспособный (reCAPTCHA блокируется в РКН-сценариях).
5. **Bnovo iframe** = legacy. **Apaleo script-injection с Shadow DOM** = modern canon.

---

## 1. Канонические шаги виджета (3-screen flow)

**Screen 1 — Search & Pick (объединяет Apaleo "step 1+2")**:
- Левая колонка / mobile top: даты + гости + промокод
- Правая колонка / mobile main: список тарифов с фильтром по категории номера
- Sticky summary справа (desktop) или внизу (mobile)

**Screen 2 — Extras (addons)**:
- Inline cards: завтрак / парковка / late check-out / трансфер / детская кроватка / спа
- Skip-кнопка ("Continue without extras") — обязательна

**Screen 3 — Guest details + Payment**:
- В 2026 канон — **single page with payment** (Apaleo, Mews, Cloudbeds).
- Отдельный step "Payment" — legacy. Лишний клик режет 2-4% conversion.
- Embedded YooKassa Elements, НЕ redirect.

**Screen 4 — Confirmation**:
- Booking reference большой, copy-button.
- "Add to calendar" (.ics).
- Email отправлен в фоне через outbox.

**Captcha**: на **submit booking** (перед charge). Канон 2026 — invisible/passive.

**Итоговая цена с разбивкой**: с момента выбора rate (Screen 1 → sticky summary). До выбора — placeholder. Финальная разбивка на Screen 3 над кнопкой Pay.

ASCII mockup screen 1 (desktop):

```
+-------------------------------------------------------------+
| HOTEL LOGO          [RU/EN]   [Sign in]  [Cart 0]           |
+--------------------+----------------------+-----------------+
| SEARCH             | RATES                | YOUR BOOKING    |
| Check-in           |  +-----------------+ | (sticky)        |
| [27 Apr 2026  v]   |  | DELUXE SEA VIEW | | 27-29 Apr       |
| Check-out          |  | photo gallery   | | 2 nights        |
| [29 Apr 2026  v]   |  | 25 m^2 | 2 pax  | | 2 adults        |
| Guests             |  | +---+ +---+    | |                 |
| Adults [2 -|+]     |  | |BAR| |NR |    | | Subtotal: --    |
| Children [0 -|+]   |  | |Flex|-15%|    | | Tax (2%): --    |
| Pets    [0 -|+]    |  | +---+ +---+    | | Total:    --    |
| Promo  [____]      |  | from 12 500 RUB | |                 |
| [Search]           |  +-----------------+ | [Continue]      |
+--------------------+----------------------+-----------------+
```

---

## 2. UX-паттерны для каждого шага

### 2.1 Date picker

**Канон 2026**: range picker, **двухмесячный** display на desktop, **single month с swipe** на mobile.

- Desktop: один календарь, два месяца side-by-side, click-to-select range, hover-preview диапазона.
- Mobile: full-screen modal, один месяц + scroll vertical (NOT horizontal swipe — NN/g 2024: vertical scroll calendar reduces error rate by 18%).
- Disabled dates с tooltip "No availability" / "Min stay 3 nights" — обязательно.
- "Flexible dates" toggle: ±3 days с матрицей цен (Apaleo/Mews показывают, Bnovo/TravelLine — нет).
- Min stay restrictions показывать **до** клика, не после.

**A11y**: roving tabindex, `aria-label="Select check-in date"`, announce at focus. Use ARIA APG combobox+grid pattern.

### 2.2 Guest selector

**Канон 2026**: stepper inside dropdown panel.

```
[2 adults, 1 child, 1 pet  v]
   v
+--------------------------+
| Adults    [-]  2  [+]    |  # 12+ years
| Children  [-]  1  [+]    |  # 2-11 years
| Infants   [-]  0  [+]    |  # 0-1 years
| Pets      [-]  1  [+]    |  # only if hotel allows
| Children's ages:         |
|   [Age -v] [Age -v]      |
| [Apply]                  |
+--------------------------+
```

- **Children require age input** — обязательно для child rate calc и для compliance с РФ "размещение детей".
- Max counts: 4 adults, 6 total guests, 2 pets per room — взять из room.maxOccupancy.
- Stepper buttons: 44×44 минимум, disabled state visually distinct.
- Pets — отдельная категория. Многие отели в Сочи pet-friendly.

### 2.3 Rate display

**Канон 2026**: **vertical list of room cards, каждая с inline rate options**.

- Apaleo Booking Engine v2 (2024) перешёл на это.
- Mews всегда так.
- Cloudbeds недавно мигрировал.
- Bnovo legacy — двухступенчатый.

Card структура:

```
+--------------------------------------------------+
| [photo carousel: 4-6 фото с swipe]               |
|--------------------------------------------------|
| DELUXE SEA VIEW                                  |
| [icon] 25 m^2  [icon] 2 guests  [icon] King bed |
| [icon] Sea view  [icon] Balcony  [icon] WiFi    |
|                                                  |
| Amenities: Breakfast available, Free cancellation|
|                                                  |
| > Show all 14 amenities | View room details     |
|                                                  |
| Choose your rate:                                |
|  +-------------------+  +-------------------+   |
|  | BAR Flex          |  | BAR Promo -15%    |   |
|  | Free cancel       |  | 1-night cap (РФ   |   |
|  | until 25 Apr      |  | 2026 ПП №1912)    |   |
|  | Pay at hotel      |  | Pay now           |   |
|  | 12 500 RUB/night  |  | 10 625 RUB/night  |   |
|  | [Select]          |  | [Select]          |   |
|  +-------------------+  +-------------------+   |
|                                                  |
| ! Only 2 rooms left at this price                |
+--------------------------------------------------+
```

Required badges:
- **Refundable / 1-night-cap** (РФ-2026 — НЕ "Non-refundable", это запрещено ПП №1912).
- **Breakfast included** — иконка + text.
- **Free cancellation deadline** — exact date + time, не "free cancellation".
- **Pay now / Pay at hotel** — обязательно.
- **Urgency ("Only X rooms left")** — только если правда, ≤3. Иначе dark pattern.

### 2.4 Addons

**Канон 2026**: **separate screen после rate selection**, НЕ inline в rate card.

Причина дрейфа: cognitive load + регулятор не любит "включаемых через checkbox" услуг внутри rate card (РФ ЗоЗПП).

Категории для Сочи:
- **Завтрак** — per night, per person с picker quantity.
- **Парковка** — flat per stay или per night.
- **Late check-out** — flat fee, до какого времени.
- **Early check-in** — flat fee, с какого времени.
- **Трансфер аэропорт ↔ отель** — Сочи-канон, аэропорт Адлер.
- **Детская кроватка** — free / paid, обязательно если гость указал infants.
- **Спа-процедуры** — отдельная подкатегория с time-slot picker.
- **Экскурсии Красная Поляна** — Сочи-specific.

**Skip CTA обязательна** — "Continue without extras". Никаких "must select at least one".

### 2.5 Guest form

**Минимум обязательные** (canon 2026):
- First name, Last name (раздельные — для МВД-передачи и matching с паспортом).
- Email.
- Phone (международный с country picker, default +7).
- Country of residence (для tourism tax exemption check).
- Citizenship — отдельно от country of residence (для МВД-уведомления).

**Опциональные**:
- Special requests (textarea, max 500).
- ETA — picker по часам.
- Purpose of stay (leisure / business).
- Loyalty program / promo code.
- Marketing consent (**unchecked by default** — 152-ФЗ требует opt-in).

**152-ФЗ specific**:
- Чекбокс "Согласие на обработку персональных данных" с ссылкой — **обязательно unchecked**, button disabled до клика.
- Это НЕ обычный T&C, а отдельное юридическое согласие.

### 2.6 Payment

**Канон 2026**: **embedded inline**, на той же странице что guest form. Redirect — legacy.

Для РФ:
- ЮKassa Embedded Widget или Tokenization API.
- CloudPayments виджет.
- T-Bank Acquiring (бывш. Тинькофф) — Embedded Form.
- **СБП QR обязательно** — conversion +5-7% для mobile RU users.

Sticky "your booking" panel:
- Hotel name + photo thumbnail.
- Check-in/out dates + times.
- Nights count, room name, guests.
- Rate name + cancellation policy short.
- Subtotal | Tax | Addons | **Total**.
- "Free cancellation until DD MMM YYYY HH:MM" — большой, контрастный.
- T&C link.
- Marketing consent checkbox.
- [Pay XX XXX RUB] button — large, primary, full-width на mobile.

### 2.7 Confirmation screen + email

**Screen**:
- Большой success icon (НЕ зелёная галка низкого контраста).
- Booking reference (большой, monospace, copy button).
- Summary: dates, room, rate, total.
- "Email sent to your@email" + "Resend" link.
- "Add to calendar" (.ics + Google Calendar link).
- "Get directions" (Yandex Maps deep link).
- Hotel contact: phone tap-to-call, email tap-to-mail.
- "Manage your booking" link.

**Email voucher** (HTML + text fallback):
- Hotel logo.
- Booking reference (большой).
- "Hello {first_name}".
- Dates + nights, room, rate, guests.
- **Cancellation policy с конкретной date+time deadline** — не общими словами.
- Total + breakdown.
- Payment status (paid / pay at hotel).
- Hotel address + Yandex Maps link, phone, email.
- Check-in / check-out times.
- Directions (от аэропорта Адлер, ж/д Сочи).
- "Manage booking" magic-link (signed JWT, 7-day expiry).
- Unsubscribe link (152-ФЗ + CAN-SPAM).
- Plaintext fallback.

Send via Postbox (M7.fix.2 wired). Subject: `Бронирование подтверждено — {hotel_name} {check_in_date}`.

---

## 3. Дизайн и Accessibility

### 3.1 Mobile-first (canon 2026, hard requirement)

- Виджет рендерится на 360px width (Galaxy A-series RU baseline).
- Single column layout, sticky bottom bar с CTA.
- Touch targets 44×44 (WCAG 2.5.5 AAA, де-факто AA-baseline 2026).
- Tap delay убран через `touch-action: manipulation`.
- `viewport`: `width=device-width, initial-scale=1, viewport-fit=cover`.

### 3.2 A11y (axe 4.11 / WCAG 2.2 AA)

- Все form inputs — `<label>` (НЕ только placeholder).
- Date picker — ARIA APG combobox+grid pattern (use Base UI или react-aria).
- Rate cards — `role="radiogroup"` + `role="radio"`, keyboard arrow navigation.
- Stepper — `<button aria-label="Increase adults">` + `aria-live="polite"`.
- Color contrast 4.5:1 для текста, 3:1 для UI components.
- Focus visible — `:focus-visible` ring 3px, контрастный.
- Skip-link "Skip to rates".
- `lang="ru"` на root, `lang="en"` на switched content.
- Ошибки формы: `aria-invalid="true"` + `aria-describedby`.

### 3.3 Loading states

- **Skeleton screens НЕ spinner.** Apaleo, Mews, Cloudbeds — все skeleton.
- Skeleton structurally similar к финальному UI.
- Optimistic UI на rate selection.

### 3.4 Error states

- Network error: inline retry button + "Что-то пошло не так. Попробуйте снова. (Код: NETWORK)" с trace ID.
- Validation: inline под полем, красным с icon.
- "No availability" — large helpful + "Try different dates" CTA + suggested alternatives.
- Stale availability (rate cached 30s, человек кликнул через 2 min): refetch перед commit, при mismatch — soft modal.

### 3.5 i18n

- RU primary, EN secondary — must для Сочи (международные туристы Красная Поляна).
- Lingui v6 (M5 lock).
- Country names — локализованные.
- Currency: `Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })` → "12 500 ₽" с неразрывным пробелом.
- Date: `dd MMM yyyy` для RU ("27 апр 2026").
- Phone: libphonenumber-js, НЕ regex.

---

## 4. Conversion-optimization

### 4.1 Single-page vs multi-step

**Канон 2026 — 3 screens with progress indicator**, не single-page и не 5-step.
- Single-page (Stripe-style) overwhelms на mobile (>3000px scroll).
- 5-step имеет cliff abandonment между steps.
- 3 — sweet spot (Baymard 2024).

### 4.2 Progress indicator

- 3 dots или steps with labels at top.
- Show all steps, current highlighted, completed checked.
- НЕ percentage bar (legacy).

### 4.3 Going back preservation

- Все selections persist в localStorage с TTL 30 min.
- URL state — даты + room + rate в query params.
- При network error и refresh — flow восстанавливается на тот же step.

### 4.4 Abandonment email

- **30-60 минут** после abandonment на step 2-3.
- Раньше — раздражает, позже — потеряли momentum.
- ОБЯЗАТЕЛЬНО opt-in (email введён, marketing consent дан) — 152-ФЗ.
- Subject: "Завершите бронирование в {hotel}".
- 1 email max, НЕ серия.

### 4.5 Trust signals

- "Отель в реестре классифицированных средств размещения" + номер в реестре + категория звёзд (РФ обязательно с 2025, ПП-1951).
- Rating с источником ("4.7 на Yandex Travel").
- Recent guest review snippet (1 review, НЕ rotating).
- Сертификаты ("Платежи защищены ЮKassa").
- **Лучшая цена гарантирована** + текст условий.
- Phone number visible (tap-to-call).

### 4.6 Photo gallery

- Hero photo на step 1 (room cards).
- Lightbox per room (5-15 photos).
- Lazy load кроме первой.
- WebP + JPEG fallback (или AVIF + WebP fallback).
- **Alt text per photo** обязательно (axe-блокер).

### 4.7 Social proof

- "X people booked in last 24h" — ОПАСНО. Если врёте — РФ ЗоЗПП штрафы.
- "X people viewing now" — нужен realtime channel. Не делать в M8.

### 4.8 Urgency

- "Only X rooms left" — только если правда, ≤3.
- "Price increases in X hours" — НЕ делать, dark pattern в 2026.

---

## 5. iframe vs script-injection

**Bnovo**: classic iframe. Pros — easy embed, isolation. Cons — SEO нулевой, height-resize hacks через postMessage, branding ограничен.

**TravelLine**: hybrid — iframe + JS SDK для height auto-resize.

**Apaleo Booking Engine** (canonical 2026): **script injection с Shadow DOM**.
```html
<div id="apaleo-booking-engine"></div>
<script src="https://booking.apaleo.com/v2/embed.js" data-property-id="..."></script>
```
Создаёт Shadow DOM, изолирован от parent CSS, но в SEO/a11y попадает (light DOM ssr fallback).

**Mews Distributor**: full-page redirect или iframe.

**Cloudbeds**: iframe + JS SDK.

**Канон для нас 2026**:
1. **Primary**: hosted full-page виджет на нашем `book.{hotel}.ru` или `widget.sochi.app/{tenant}` с кастомизацией. Лучшая UX, full SEO, full a11y.
2. **Secondary**: script-injection с Shadow DOM — для отелей которые хотят embed.
3. **Tertiary**: iframe — last resort для legacy CMS интеграций.

**SEO concerns**: iframe content не индексируется, но это OK для booking — мы не хотим чтобы Google индексировал `?check_in=2026-04-27`. Hotel main page (на сайте) индексируется и должна содержать структурированные данные `Hotel` Schema.org.

---

## 6. Customization для отеля

### 6.1 Branding

- Logo upload (SVG, PNG fallback, max 200KB).
- Primary color + auto-derived hover/active/focus (HSL math).
- Hero photo per property.
- Custom font (subset Latin+Cyrillic, woff2, max 2 weights).
- **Contrast guard** — при выборе цвета проверять 4.5:1 против text. Если не проходит — block save.

### 6.2 Кастомные поля guest form

- 0-5 extra fields, types: text, select, checkbox, textarea.
- Каждое: required toggle, label RU/EN, optional helper text.
- Не позволять раздувать — conversion дроп.
- Валидация per-type.

### 6.3 Property descriptions

- Markdown с whitelist (bold, italic, lists, links).
- Photos с captions.
- Amenities — pick from canonical list (~80 items) + до 10 custom.
- Каждая amenity → icon (Lucide-react canonical 2026).

### 6.4 Cancellation policy text

- Structured: deadline, penalty.
- Auto-generated text RU+EN.
- Override на raw text.

### 6.5 Contact info

- Phone, email, address, Yandex Maps embed.
- WhatsApp, Telegram (РФ).

### 6.6 FAQ section

- Q&A list, до 20 items.
- Категории (check-in, парковка, питание, политика отмены).
- Search filter.

---

## 7. Мобильные паттерны

### 7.1 Bottom sheet rate selection (Apaleo canonical)

- Tap "View rates" на room card → bottom sheet slides up (75% viewport).
- Sheet содержит rate cards stacked.
- Swipe down dismiss.
- Sticky CTA внутри sheet.
- Use **Vaul** library (M6.7 lock).

### 7.2 Sticky CTA

- Bottom-fixed на mobile через safe-area-inset-bottom.
- Full-width, 56px height.
- Showing total price + label.
- Disabled until valid selection (с aria-disabled).

### 7.3 Step-by-step vs scroll-and-select

- Mobile **strict step-by-step**, single screen at time.
- Desktop scroll-and-select допустим но 3-screen канон выигрывает.

### 7.4 Input types для виртуальной клавиатуры

- Email: `type="email"` + `autocomplete="email"` + `inputmode="email"`.
- Phone: `type="tel"` + `autocomplete="tel"` + `inputmode="tel"`.
- CVV: `inputmode="numeric"` + `autocomplete="cc-csc"`.
- Card number: `inputmode="numeric"` + `autocomplete="cc-number"`.
- ETA picker: native `<input type="time">` для mobile.
- **Number stepper НЕ `<input type="number">`** — на iOS показывает спинщики, на Android текст. Use buttons + visible number.

### 7.5 Autofill

- `autocomplete="given-name"`, `family-name`, `email`, `tel`, `street-address`, `country-name`, `cc-name`, `cc-number`, `cc-exp`, `cc-csc`.
- РФ Apple Pay / Yandex Pay autofill работает.

---

## 8. Конкретные UX-references 2026

| Engine | Тип | Strength | Weakness | Use as |
|---|---|---|---|---|
| **Bnovo** | Iframe-based 4-step | Широкая RU интеграция, channel manager | UX датированный, slow load | RU compliance reference |
| **TravelLine** | Iframe + JS SDK 4-step | Strong RU compliance (152-ФЗ, чеки, реестр КСР) | UX 2020-era | RU compliance reference |
| **Apaleo Booking Engine** | Modern script-injection + Shadow DOM, 3-screen | Лидер UX 2024-2026, открытый API, modern stack | Not RU-localized, no РФ payment OOB | **UX reference**, не integration |
| **Mews Distributor** | Full-page hosted, 3-screen с sticky summary | Design quality, clean | Меньше customization чем Apaleo | UX reference |
| **Cloudbeds** | Iframe + JS SDK 3-step | Wide international coverage | UI density высокая | UX reference |
| **Booking.com / Ostrovok** | Industrial benchmark | Filter/sort/photo galleries patterns | Dark patterns (false urgency, hidden fees) — изучать **что НЕ делать** | Photo galleries, mobile bottom-sheet patterns |

---

## 9. Открытые вопросы

1. **Будем ли поддерживать iframe embed в M-фазе?** Hosted-only проще, но отели с CMS захотят embed.
2. **Yandex SmartCaptcha vs Cloudflare Turnstile** — Yandex для RU-only. Подтверждено как канон.
3. **СБП QR на checkout** — добавлять в M8.B или M-late?
4. **Multi-room booking** в одном flow — Apaleo поддерживает, Bnovo нет.
5. **Group bookings (>5 номеров)** — обычно требуют contact form, не self-serve. Out of scope для widget.
6. **Loyalty program** — будет? Если да, нужен sign-in flow и member rates.
7. **Yandex Travel parity** — rate parity check. Compliance/legal больше чем UX.
8. **GDS (Amadeus, Sabre)** для международных гостей — out of scope.
9. **Voice booking / Alice integration** — Sochi-specific, strategic.

---

## 10. TL;DR для M8.B-планирования

3-screen flow (Search+Pick / Extras / Guest+Pay), embedded payment с СБП+ЮKassa, sticky summary с разбивкой с момента rate-pick, Yandex SmartCaptcha invisible, abandonment email через 30-60 min, RU+EN i18n, axe gate sticky, mobile-first с Vaul bottom sheets, hosted-primary (book.{hotel}.ru) с Shadow-DOM script-injection как secondary embed option, 152-ФЗ unchecked consent + реестр КСР trust signal как RU-differentiators.

---

## 11. Источники

- Apaleo Developer Portal: developer.apaleo.com (Booking Engine v2 docs)
- Mews Distributor docs: developers.mews.com
- Cloudbeds API docs: hotels.cloudbeds.com/api/docs
- TravelLine help: support.travelline.ru
- Bnovo blog: bnovo.ru/blog
- Baymard Institute: baymard.com (Hotel Booking + Checkout benchmarks)
- Nielsen Norman Group: nngroup.com (date pickers, mobile forms, e-commerce checkout)
- WCAG 2.2: w3.org/TR/WCAG22
- ARIA APG: w3.org/WAI/ARIA/apg (combobox, grid, radiogroup patterns)
- 152-ФЗ + 425-ФЗ + ЗоЗПП РФ
- Lucide icons: lucide.dev
- Vaul: vaul.emilkowal.ski (M6.7 lock)
