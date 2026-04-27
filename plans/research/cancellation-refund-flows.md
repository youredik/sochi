# Research: Cancellation Policy + Refund Flows Canonical 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 2 (Apaleo + Mews + Cloudbeds + Booking.com VCC + ПП РФ №1912)
**Confidence:** High (RF-2026 rules, Apaleo, 54-ФЗ refund mechanics, Booking.com VCC), Medium (Mews voucher taxonomy, Ostrovok webhook), Low (Я.Путешествия programmatic cancellation)

---

## 0. ⚠️ КРИТИЧЕСКАЯ НАХОДКА — ПП РФ №1912 от 27.11.2025

**Постановление Правительства РФ № 1912 от 27.11.2025, в силе с 1 марта 2026** — фундаментальный сдвиг для российской hospitality:

- **Все бронирования возвратные.** Понятие "невозвратный" (BAR-NR) **удалено**.
- **Cancel до дня заезда → 100% возврат обязателен по закону.**
- **Cancel в день заезда / опоздание / no-show → удерживается НЕ БОЛЕЕ стоимости 1 суток.**
- Hotel **обязан** держать reservation до calculation hour (typically 12:00) дня после expected arrival.
- Mandatory disclosure: размер номера, условия отмены, порядок возврата предоплаты, регистрация в реестре.

**Implication для нашей системы:**
- BAR-NR (legacy non-refundable) **больше не применим** в РФ. Должен быть rebrand'ed как `BAR-PROMO-1N` — discount preserved, penalty cap = 1 night.
- Для OTAs которые публикуют 100% NR policy — OTA-side terms governed их own ToS, но hotel **не может enforce >1 night** против гостя под consumer law.
- Tiered penalty schedules (T-30/T-14/T-7/...) теряют практический смысл в B2C — практически binary: 0% before arrival, 1 night after.
- B2B/group/corporate — могут иметь свободные contractual penalties (consumer law не применяется к ЮЛ).

---

## 1. Канонические cancellation policy types (2026, post ПП №1912)

| Code | Name | Free-cancel window | Penalty after window | RU-2026 status |
|---|---|---|---|---|
| `BAR-FLEX` | Best Available, fully flexible | до 18:00 в день заезда (24h в брендовых) | First-night charge | Permitted; cap = 1 night |
| `BAR-MOD` | Moderate | 24-72h до заезда | First-night | Permitted; cap = 1 night |
| `BAR-STR` | Strict | 7-14 дней до заезда | First-night (по новому правилу — не больше) | Permitted with disclosure |
| `BAR-PROMO-1N` | Discounted promo (бывший NR) | none | First-night | **Replaces BAR-NR.** Discount preserved (e.g., -15%), penalty capped at 1 night |
| `LOS-PROMO-1N` | Long-stay promo (≥7 nights) | none | First-night | Same RF cap |
| `PAY-ON-ARRIVAL` | Hotel-collect, no prepayment | n/a | No-show fee = 1 night | Standard |
| `PAY-NOW` / `PREPAID` | Full prepayment, refundable per window | по расписанию | First-night | Standard |
| `GROUP` | Group block (≥10 rooms) | контрактная attrition (90/60/30/14/0 days) | Tiered % | Permitted via B2B contract; consumer law не применяется к ЮЛ |
| `CORPORATE` / `NEG` | Negotiated rate с corp | per контракт | per контракт | B2B contractual freedom |
| `EVENT-PEAK` | Olympic/festival peak | extended (14-30d) | First-night | Permitted, must disclose |

**Apaleo canon**: rate plan must reference one `cancellationPolicy` and one `noShowPolicy`. Both store fee as `fixed amount | % of N nights | % of full stay | first-night`. `cancellationPolicy.dueDate` = computed deadline.

**Booking.com BCCP codes**: 7 active codes per property, classified into pre-arrival vs on/after arrival, с penalty buckets 0/50/100%.

**Mews**: only flat "non-refundable rate" boolean + `cancellationFeeRule` (none / first-night / N% / full). No native "moderate" 3-tier schedule — tiering implemented via multiple rate plans.

### 1.1 Recommendation для нашего ratePlan schema

Extend от current `isRefundable + cancellationHours` к `cancellationPolicy` discriminated union:

```ts
type CancellationPolicy =
  | { kind: 'free_until_hours', hours: number, postPenalty: PenaltyRule }
  | { kind: 'tiered', steps: PenaltySchedule[] }
  | { kind: 'locked_first_night' }  // = former NR под RF cap

type PenaltyRule = {
  type: 'first_night' | 'percent' | 'fixed'
  value: number  // for percent: 0-100; for fixed: micros
  includesAddons: boolean
}
```

Это matches Apaleo + Booking.com BCCP simultaneously.

---

## 2. Penalty schedules

**Tiered schedule** (canonical "moderate" Hilton-style):

```
T-30d  : 0%  (free)
T-14d  : 25% of stay  OR  first-night, whichever is greater
T-7d   : 50% of stay
T-72h  : 100% first-night
T-24h  : 100% first-night + non-refundable taxes/fees
T-0    : no-show → 100% first-night (RF-2026 cap)
```

**Russian 2026 reality** — courts will not enforce >1 night против consumer независимо от schedule. Практическая schedule под RF — binary: **0% before arrival date, 1 night after**.

**First-night vs entire stay**: industry converged на first-night как de-facto penalty unit (Marriott, Hilton, Hyatt, Apaleo default).

### 2.1 Tax handling в penalty

- **VAT (НДС 22% с 2026)**: cancellation fee — компенсация за нерendered service. ФНС позиция: компенсация → **НДС не начисляется** (см. п.1 ст.146 НК). Implementation: separate fiscal subject в receipt, не "услуга проживания".
- **Tourism tax 2% Сочи 2026**: per НК ст. 418.7 — tax accrues only на actual provided accommodation. Cancelled → no tax. **No-show с 1-night fee — debate**: best reading НЕ начислять (нет физического проживания). Match this в нашем `tourismTaxOrgReport` — currently excludes `cancelled`, **bug fix**: also exclude `no_show` from tax base.

### 2.2 Force majeure

- РФ ст. 401 ГК: освобождение от ответственности за непреодолимую силу. Гость не платит штраф если документально докажет.
- Hotel side reciprocal: если отель не смог принять (пожар, отключение коммуникаций) — refund full + relocation.
- Industry: typically requires evidence (medical certificate, government advisory, airline cancellation document).
- COVID-era: pandemic-specific clauses persist как `EXCEPTIONAL_CIRCUMSTANCES`.

---

## 3. Cancellation flow по источнику

### 3.1 Admin operator

Full control:
- Cancel + auto-post fee per policy (default).
- Cancel + waive fee (manual override → audit log с reason + actor).
- Cancel + custom fee (e.g., 50% goodwill).
- Refund payment in full / partial / not at all.

**Apaleo flow**: `PUT /booking/v1/reservation-actions/{id}/cancel` → `Canceled` status. Posting fee = **separate** call: `POST /finance/v0-nswf/folio-actions/{folioId}/cancellation-fee`. Decoupling enables waiver flow.

**Наш текущий код**: `PATCH /bookings/:id/cancel` с `reason`. **Missing piece**: fee posting НЕ separate step — should mirror Apaleo's split. Add `POST /folios/:id/post-cancellation-fee` с optional `amountOverride`.

### 3.2 Public guest (email link / IBE)

- Self-service `cancel` link в confirmation email. Под RF-2026 rules — гость **обязательно может cancel без contacting hotel**.
- Token-based, single-use, expires at check-in.
- Inside free-cancellation window → instant confirmation email + auto-refund initiated.
- Outside window → self-service с fee shown + confirmation, либо "contact us" fallback.
- **Cooling-off period**: NO general 14-day для hotels в EU/RF. RF-2026 made cancellation up to arrival date free — стricter than EU cooling-off.

### 3.3 Channel pull (OTA)

#### Booking.com

1. Guest cancels via Booking.com.
2. Booking.com шлёт `OTA_HotelResNotifRQ` с `ResStatus="Cancelled"` channel manager'у.
3. CM пушит в PMS.
4. PMS auto-cancels booking.
5. **Refund logic зависит от payment model**:
   - **Hotel Collect**: hotel charged guest's card directly. Refund through own acquirer (YooKassa).
   - **Channel Collect (Payments by Booking.com / VCC)**: Booking charged guest. Hotel charged VCC. На cancel hotel refunds VCC; Booking refunds guest. **VCC works for refund даже после card expiry**, 60-90 day window.

#### Я.Путешествия

- Guest cancels в Я.Путешествия app/site → propagation в hotel via channel manager (TravelLine/Bnovo/Shelter).
- Refunds для prepaid bookings — Я.Путешествия facilitates; hotel может быть debited via deduction from next payout.
- Commission (15-17%) — non-refundable для Я.Путешествия on cancelled bookings unless cancelled within their grace window.
- **⚠️ Critical gotcha**: Я.Путешествия cancellations через some CM (e.g., Shelter Cloud) **may not flow back to PMS** — Shelter requires manual handling в Я.Extranet. Plan for reconciliation jobs.

#### Ostrovok

- Two payment models: ETG-collect (Ostrovok charges guest, sends VCC) vs hotel-collect.
- Cancellation flow same as Booking — XML push to CM → PMS.
- Refund: ETG-collect → ETG refunds guest, debits hotel via reconciliation. Hotel-collect → hotel refunds.

### 3.4 No-show

- **Trigger**: automated cron at check-out time of day after expected arrival (Apaleo waits until next day's checkout time).
- Status `confirmed` → `no_show` after check-in date passes без check-in.
- Auto-post no-show fee (= 1 night под RF rules).
- **Уже implemented в M7.A.4** — verify cap is 1-night, не full-stay.

### 3.5 Walked guest (overbooking)

**RF-2026 rule (ПП №1912)**: hotel который не может accommodate guest **обязан** провести equivalent или higher category accommodation **at no extra cost**, plus return any difference.

Industry standard "walking" compensation:
- 1 night room + tax at relocation hotel.
- Transport to alternative property.
- Phone call + internet at relocation hotel.
- Loyalty program top-up.
- Return of any prepayment (must, под RF).

**Implementation**: new booking status transition / new event type `relocated` distinct от `cancelled`. Folio carries: original charge → 100% rebate + relocation expenses recorded as house account, paid out manually.

---

## 4. Apaleo cancellation model (canonical)

States: `Confirmed → Canceled` | `Confirmed → InHouse → CheckedOut` | `Confirmed → NoShow` (terminal).

Reasons (free-text + recommended taxonomy):
- `GuestCancellation`
- `NoShow`
- `OverbookingWalk`
- `HotelClosure`
- `PaymentFailed`
- `Duplicate`
- `Fraud`
- `OperationalError`

API surface:
- `PUT /booking/v1/reservation-actions/{id}/cancel` — moves status, requires `reason`.
- `POST /finance/v0-nswf/folio-actions/{folioId}/cancellation-fee` — posts the configured fee.
- `POST /finance/v0-nswf/folio-actions/{folioId}/no-show-fee` — analogous.
- `PUT /finance/v1/folio-actions/charges/{id}/move-to-house` — waiver via moving to house account.

Fee **не auto-posted** на cancel — explicit second call. Operator chose 0%/50%/100%.

Refund — **separate again** — handled via integrated payment provider.

**Наш model alignment**: M6 payment domain has `Refund` as separate row keyed to `Payment`. Cancellation fee should be **folio charge**, refund is **payment-side action**. Bridge code: when booking cancels and policy says "first-night fee", we (a) post folio charge equal to first-night gross, (b) issue refund для `paid - first_night` against original payment.

---

## 5. Mews / Cloudbeds taxonomy

**Mews**:
- Cancellation handled at reservation-status tab; "Apply cancellation fee" tickbox.
- Refundable rates: cancellation fee N/A (auto-rebate full).
- Non-refundable: full charge stays. After payment, "rebate" (Mews term для refund-as-credit-against-bill).
- Modification during stay (e.g., shorter stay) → adds cancellation fee для cancelled nights + new charges для modified dates.
- **No "voucher" / "credit" concept** в Mews PMS-native — refund is monetary only.

**Cloudbeds**:
- Cancellation policy is **informational**, no auto-charge — operator must manually charge fee.
- "Cancel For Any Reason" add-on (rolling out Q1 2026) — guest pays small non-refundable insurance fee, gets full refund на cancel within window даже from non-refundable rate.
- Refunds: 5-7 business days, original payment method, only via Cloudbeds Payments.

**Modification vs cancellation**: industry treats modification как **cancel + rebook**. Best PMS practice: keep `bookingId` stable on modification, snapshot `timeSlices` history для audit, charge difference but never the cancellation fee.

---

## 6. Refund mechanics

| Aspect | Canonical 2026 |
|---|---|
| Full refund | Refund = paid amount. Original method. T+1 to T+10 banking days. |
| Partial refund | Refund = paid - retained_fee. Reason on receipt. |
| No refund | Only legal in B2B; в RF B2C — only если 1-night cap applied to full prepayment of 1 night. |
| Refund timing | YooKassa: ~seconds to 20min в API status; bank settlement T+1 to T+5. Real card refund: 5-30 days в зависимости от issuer. Communicate "5-10 рабочих дней" гостю. |
| Method | Original card mandatory под bank rules (PCI/issuer). YooKassa `refunds` endpoint accepts no destination — tied to source payment. |
| Expired card | YooKassa: refund still goes к **same card token**; bank routes to new card or returns to issuer's customer-service. Booking.com VCC: refund works даже if expired. Last-resort: bank transfer с signed application. |
| 54-ФЗ refund receipt | Required. Recipient = `возврат прихода`. Same VAT as original (per ФНС 2026 — VAT-rate-locked-to-source). YooKassa generates автоматически с `receipt` param на refund call. |
| Two-step (void + refund) | Pre-capture: cancel auth (no money moved). Post-capture: refund. |
| Cumulative cap | `SUM(refunds.succeeded) <= payment.captured`. **Already enforced** в нашем `Refund` domain. |
| Multi-payment refund order | YooKassa: каждый payment refunded independently. Order: **deposit first, then balance** (LIFO of payments) — standard hotel practice. |

### 6.1 RF 54-ФЗ specifics

- Refund receipt issued **same day as money goes back**, не when guest requests.
- Для non-cash refunds, receipt formed **within 5 рабочих дней** of money leaving account.
- VAT rate на refund receipt = VAT rate на original receipt (locked, даже после rate change 20% → 22% on 01.01.2026).
- Tag 1054 = `4` (возврат прихода).

---

## 7. Channel-pulled cancellations matrix

| Channel | Payment model | Cancel propagation | Who refunds | Hotel-side action | Reconciliation gotcha |
|---|---|---|---|---|---|
| Booking.com Hotel-Collect | Hotel charged | CM push | Hotel via own acquirer | Refund through YooKassa | Card may expire; fall back bank transfer |
| Booking.com Channel-Collect (VCC) | Booking charged guest, VCC issued | CM push + VCC update email | Hotel refunds VCC; Booking refunds guest | Refund through normal acquirer using VCC | 60-90d window; can refund expired VCC |
| Я.Путешествия prepaid | Я.Travel charged guest | CM push (some don't propagate — Shelter known) | Я.Travel refunds, settles via payout deduction | Confirm cancellation в Extranet | Reconciliation lag; manual job |
| Ostrovok ETG-collect | ETG charged, VCC to hotel | XML push | ETG refunds guest, deducts from hotel payout | Confirm в Ostrovok partner panel | Same VCC pattern as Booking |
| Ostrovok hotel-collect | Hotel charges | XML push | Hotel | Hotel acquirer refund | Standard |
| TravelLine direct | Hotel-collect always | Native | Hotel | Acquirer refund | Standard |
| Bnovo | Both models | Native | Per model | Per model | Standard |

Sandbox-friendly mocks: emit synthetic `OTA_HotelResNotifRQ` с `ResStatus=Cancelled` to channel-pull endpoint. Для VCC cases — emit fake-VCC payload с masked PAN.

---

## 8. Cancellation status state machine

```
                ┌─────────────────────────┐
                ▼                         │
   ┌──→ confirmed ──cancel(operator)──→ cancelled    [terminal]
   │      │  │
   │      │  ├──cancel(guest)──────────→ cancelled
   │      │  │
   │      │  ├──cancel(channel pull)──→ cancelled
   │      │  │
   │      │  ├──cron @check_in+1day──→  no_show     [terminal]
   │      │  │
   │      │  ├──relocate(overbooking)→  walked      [terminal, requires
   │      │  │                                       relocation booking]
   │      │  ▼
   │      ├ check_in ──→ in_house ──check_out──→ checked_out  [terminal]
   │      │                  │
   │      │                  └──early_checkout──→ checked_out
   │      │
   │      └ modify_dates ──→ confirmed (same id, new timeSlices, audit trail)
   │
   └────  un_cancel  ←──── cancelled  [DISALLOWED — "оживление" = new booking]
```

**Transitions allowed**:
- `confirmed → cancelled` ✓
- `confirmed → in_house` ✓
- `confirmed → no_show` ✓
- `in_house → checked_out` ✓
- `confirmed → walked` (NEW — не в нашем current 5-state)
- `cancelled → confirmed` (un-cancel) — **DISALLOWED**, industry consensus = NO. Reactivating cancelled creates audit problems с refund-receipts (54-ФЗ).

---

## 9. Russian compliance (most critical)

1. **ПП №1912 от 27.11.2025** (in force 01.03.2026):
   - Все бронирования возвратные.
   - Cancel до дня заезда → 100% возврат.
   - Cancel в день заезда / опоздание / no-show → не более 1 суток.
   - Hotel must hold reservation until calculation hour (12:00) дня после expected arrival.
2. **Закон РФ № 2300-I "О защите прав потребителей", ст. 22**:
   - Refund within **10 days** of consumer's claim.
   - Просрочка → пеня 1% за каждый день. С 01.02.2026 пеня капится суммой товара.
3. **54-ФЗ refund receipts**:
   - Признак расчета: `возврат прихода` (тег 1054 = 4).
   - VAT-locked to source.
   - Срок формирования при non-cash: 5 рабочих дней.
4. **Тур.налог 2% Сочи (НК ст. 418.7)**:
   - НЕ начисляется при `cancelled`.
   - Спорно при `no_show` — best reading НЕ начислять.
   - **Текущий код** учитывает это для `cancelled`; **нужно проверить** что `no_show` тоже не попадает в базу.
5. **152-ФЗ**: данные паспорта в `bookingGuestSnapshot` хранятся до закрытия года + 5 лет (МВД retention) + далее обезличивание.
6. **ГК ст. 401, 416, 451**: force majeure — full refund, no fee. Documentary proof required.

---

## 10. Tax consequences

| Scenario | НДС 22% | Тур.налог 2% | Доход |
|---|---|---|---|
| Cancel free | ✗ | ✗ | ✗ (refund full) |
| Cancel с 1-night fee | Compensation, no VAT | ✗ (no actual stay) | + 1 night fee |
| No-show, 1 night charged | Same as above | ✗ | + 1 night |
| Walked guest (relocate) | Refund VAT proportionally | Refund tour tax | Loss |
| Refund partial | VAT on refund receipt = VAT в original | Tour tax base reduced | Income reduced |

**Critical fix в нашем `tourismTaxOrgReport`**: currently `excludes cancelled`, но spec says `no_show retains liability`. Per RF-2026 reading + НК — no_show without actual occupancy should not accrue tour tax. **Recommend**: change to `excludes status IN ('cancelled', 'no_show')`. Verify с tax counsel.

---

## 11. Edge cases & resolutions

1. **Multi-night booking, cancel 1 day before** → penalty = 1 night (не full stay). RF-2026 cap.
2. **Modification of dates** → cancel + rebook semantically. Implementation: keep `bookingId`, append new `timeSlices`, store `modifiedAt`. Если new dates higher rate, charge diff. **No** cancellation fee если modification within free window.
3. **Late cancel after check-in time same day** → counts as no-show. Только 1-night penalty either way.
4. **Group booking, cancel 50% of rooms** → partial cancellation. Каждая room handled independently against group attrition. Implementation: treat as N independent bookings inside `bookingGroup` parent.
5. **Refund to expired card** → bank-side handling: most issuers route to new card or send to customer-service. Fall-back: bank transfer с signed application (152-ФЗ data handling).
6. **Multi-payment refund** (deposit + balance) → refund balance first, then deposit (chronological reverse). Each payment's refund row tracked separately.
7. **Guest paid via Booking.com VCC, hotel cancelled** → refund VCC, Booking refunds guest's actual card. 60-90d window.
8. **Я.Путешествия cancellation that didn't propagate** → daily reconciliation cron: pull cancellation list from Я.Travel API, diff against bookings, queue manual review tasks.
9. **Guest cancels, then disputes refund didn't arrive** (issuer-side delay): show refund payment status, expected arrival date, bank reference number в guest portal.
10. **Cancellation during stay (early check-out)** → не cancellation, а folio adjustment. Refund unused nights per RF-2026 (mandatory).

---

## 12. UX для public guest cancellation

Mandatory components per RF-2026 + best practice 2026:
1. **Email link** — signed JWT token, single-use, expires at check-in datetime.
2. **Self-service page** showing: booking summary, cancellation deadline, fee preview, "Cancel" button.
3. **NO universal 14-day cooling-off**. RF-2026 effectively gives "cooling-off until arrival date".
4. **Confirmation email** post-cancel с refund timeline, refund amount, payment reference, fiscal receipt attachment.
5. **Communication template**: "Деньги вернутся на ту же карту в течение 5–10 рабочих дней. Чек возврата прилагается. Если средства не пришли через 10 дней — обратитесь в свой банк по справочному номеру [REF] или к нам по [contact]."
6. **Idempotency**: cancel button должен быть idempotent — guest clicking twice не должен double-refund (covered by `causalityId` UNIQUE constraint).

---

## 13. State machine deltas vs наш current code

Current `bookingStatusValues = ['confirmed','in_house','checked_out','cancelled','no_show']`.

**Recommended additions**:
- `walked` — overbooking relocation (RF-2026 mandatory).
- Optional: `pending` для OTA-pull bookings awaiting guest confirmation; не нужно для direct/IBE.

`cancelReason` exists но free-text. Recommend adding `cancelReasonCode` enum (per Apaleo): `guest_request | no_show | overbooking | hotel_closure | payment_failed | duplicate | fraud | operational_error | force_majeure`.

---

## 14. Open questions

1. **VAT on cancellation fee в RF**: treat as compensation (no VAT) или service (22% VAT)? — needs accountant signoff.
2. **Tour tax on no-show retained 1 night** — refund or accrue? Best reading: refund.
3. **Refund receipt when guest cancels via Booking.com VCC, we refund VCC, Booking refunds guest** — who fiscalizes? We must (received original payment). Verify с fiscal operator.
4. **Я.Путешествия webhook for cancellation** — public API spec missing; need test against staging.
5. **Cancellation outside window via email link** — should self-service charge 1 night automatically, или operator review? Best UX: charge automatically, с operator-side waiver workflow.
6. **Group bookings (≥10 rooms) под RF-2026** — does 1-night cap apply to legal entities? Likely no (consumer law not applicable to B2B).
7. **`organizationProfile.refundPolicyDisclosure`** field — RF-2026 mandatory. Не yet have в `organizationProfile`; needs migration.

---

## 15. Files relevant

- `/Users/ed/dev/sochi/packages/shared/src/booking.ts` — current 5-state SM, `bookingCancelInput`, `bookingMarkNoShowInput`, `cancellationFee`/`noShowFee` snapshots.
- `/Users/ed/dev/sochi/packages/shared/src/refund.ts` — 3-state refund SM, causality-id enumeration; cumulative cap invariant.
- `/Users/ed/dev/sochi/packages/shared/src/ratePlan.ts` — current `isRefundable + cancellationHours` model; needs upgrade to discriminated union.

---

## 16. Sources

- [Постановление РФ от 27.11.2025 N 1912 (Garant)](https://www.garant.ru/products/ipo/prime/doc/413069805/)
- [КонсультантПлюс — новые правила гостиничных услуг с 1 марта 2026](https://www.consultant.ru/law/hotdocs/91736.html)
- [TravelLine — Невозвратный тариф 2026](https://www.travelline.ru/blog/nevozvratnyy-tarif-v-otele/)
- [Я.Travel — Невозвратные тарифы что изменилось](https://travel.yandex.ru/pro/nevozvratnye-tarify-chto-izmenilos-dlya-oteley-i-posutochnyh-obektov/)
- [Apaleo — Cancellation and No-Show Policies](https://apaleo.zendesk.com/hc/en-us/articles/360001719032)
- [Apaleo — Reservation Status](https://apaleo.zendesk.com/hc/en-us/articles/13241740952476)
- [Mews — Hotel cancellation policy guide](https://www.mews.com/en/blog/hotel-cancellation-policy)
- [Cloudbeds — Cancel For Any Reason](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/39401241438875)
- [Booking.com — Cancellation Policies (Demand API)](https://developers.booking.com/demand/docs/orders-api/cancellation-policies)
- [Booking.com — BCCP cancellation policy codes](https://developers.booking.com/connectivity/docs/codes-bccp)
- [Booking.com — Refunding VCCs](https://partner.booking.com/en-us/help/policies-payments/payment-products/refunding-virtual-credit-cards-vccs)
- [YooKassa — 54-FZ refund receipts](https://yookassa.ru/docs/support/merchant/payments/refunds/refunds-54fz)
- [Гарант — ЗоЗПП ст. 22](https://base.garant.ru/10106035/94f5bf092e8d98af576ee351987de4f0/)
- [Контур — Чеки с НДС в переходный период 2026](https://kontur.ru/market/spravka/82816-cheki_s_nds_v_perehodnyy_period)
- [Sochi.ru — Туристический налог](https://sochi.ru/gorod/turizm/turisticheskiy-nalog/)
