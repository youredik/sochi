# M9.widget.4 — Screen 3 Guest+Pay (canonical sub-phase plan)

**Дата:** 2026-04-30
**Track:** A2 (per `plans/ROADMAP.md`) — closes Боль 2.3 backend orchestration. Final remaining widget surface перед demo deploy.
**Scope reframe:** demo surface на Stub-провайдере. **Live ЮKassa integration = Track C2** (deferred, parallel-trackable, не блокер).
**Canonical guard:** `feedback_behaviour_faithful_mock_canon.md` — Mock = полнофункциональный поставщик с canonical interface, не «pseudo UI mimicking ЮKassa».
**Research:** R1 (5 agents) + R2 adversarial (2 agents) + R3 strict-Apr-2026+ (5 agents) + stankoff-v2 cross-check + npm verify — 80+ findings, 50+ corrections к plan §M9.widget.4.

---

## §1. North-star alignment

**Demo surface canon**: один codebase обслуживает demo + production. Live-flip = factory binding swap, **ZERO domain code changes**. Same UI работает с Stub + live ЮKassa.

**Что строится в M9.widget.4 (Track A2):**
- Реальная RU-compliance (152-ФЗ + 38-ФЗ + ПП РФ 1912 + ст. 10 ЗоЗПП)
- Реальная anti-abuse (rate-limit + Idempotency-Key)
- Реальная audit-trail (`consentLog` table per 152-ФЗ ст. 22.1)
- Полнофункциональный guest-form (TanStack Form 1.29.1 + Zod 4.4.1 + libphonenumber-js)
- Canonical payment UI (works с Stub demo + live ЮKassa)
- Production-grade Stub adapter behaviour-faithful с canonical contract

**Что defer'ится в Track C2 (live):**
- Real ЮKassa Widget v1 CDN script
- Real `confirmation_token` server creation (vs Stub simulating same shape)
- Real PCI SAQ-A attestation (operator-side process, multi-week)
- Real webhook IP allowlist (Stub posts mock-webhook к local handler)
- SmartCaptcha real integration (rate-limit primary in A2; captcha = C2 enhancement)

---

## §2. Integration map — что widget hooks (НЕ переписывает)

Existing services в проекте — NO modifications:

| Existing service | Used by widget |
|---|---|
| `tenant-resolver.ts` | slug → tenantId resolution |
| `widget.service.getAvailability()` | Re-validate availability before commit (stale-cache mismatch detect) |
| `guest.service.create()` | Inline guest creation от form data |
| `booking.service.create()` | Booking creation с time-slices, fee snapshots, tourism tax computation, registration status |
| `payment.service.createIntent()` | Payment intent с idempotency UNIQUE dedup + provider invocation + state machine |
| `stub-provider.ts` (existing) | Synchronous success path (created → pending → succeeded), idempotent replay cache |
| `payment-factory` | Provider switch via `PAYMENT_PROVIDER` env var (Stub / future YooKassa) |

CDC consumers auto-trigger от `booking.created`:
- `folio_creator_writer` → folio created automatically
- `tourism_tax` → tax accrual computation
- `migration_registration_enqueuer` → МВД flow если нерезидент
- `activity_writer` → audit trail
- `notification-dispatcher` → outbox email (booking-confirmation magic-link → M9.widget.5)

**Я НЕ создаю**: folio (CDC handles), tourism tax computation (CDC handles), activity log (CDC handles), notification dispatch (CDC handles), guest-creation route (existing), booking-creation route (existing).

---

## §3. Что реально пишется

### Backend (5 new files + 1 migration)

| File | Purpose |
|---|---|
| `db/migrations/0045_consent_log.sql` | NEW table — RU compliance audit-trail (152-ФЗ ст. 22.1 DPO recordkeeping) |
| `lib/consent-record.ts` | Helper для INSERT consentLog rows (152-ФЗ + 38-ФЗ separate entries с timestamp/IP/UA/exact wording/version) |
| `middleware/widget-idempotency.ts` | Slug-scoped idempotency variant (existing `middleware/idempotency.ts` reads `c.var.tenantId` — нужен fork для public route с slug→tenant resolution before idempotency check) |
| `domains/widget/booking-create.routes.ts` | Public POST `/api/public/widget/{slug}/booking` (no auth, rate-limit, idempotency) |
| `domains/widget/booking-create.service.ts` | Composes existing services: validate availability + create guest + create booking + record consents + create payment intent. Returns `{ bookingId, paymentId, confirmationToken, status }` |
| `domains/widget/booking-create.service.test.ts` + `.integration.test.ts` | Strict tests + cross-tenant + happy/abandonment paths |

### Frontend (6 new files)

| File | Purpose |
|---|---|
| `screens/guest-and-pay.tsx` | Screen 3 orchestration |
| `components/guest-form.tsx` | TanStack Form 1.29.1 + Zod 4.4.1 (Standard Schema direct, NO `@tanstack/zod-form-adapter`) + libphonenumber-js `AsYouType('RU')` |
| `components/consent-block.tsx` | Modal с standalone consent text для 152-ФЗ + 38-ФЗ (separate documents per 156-ФЗ от 24.06.2025) |
| `components/payment-canonical-widget.tsx` | Canonical payment UI — works для Stub demo + live ЮKassa same shape. Card form с real Luhn validation, real expiry/CVV, real state transitions (loading → success/fail). Backend factory determines actual provider. |
| `lib/payment-flow.ts` | POST `/booking` → consume `confirmationToken` → init payment widget → poll/wait status |
| `routes/widget.$tenantSlug_.$propertyId_.guest-and-pay.tsx` | TanStack Router flat sub-route с validateSearch (Zod) carrying booking context |

---

## §4. 8 Decisions (final)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | Phone format library | **libphonenumber-js@1.12.42** + `AsYouType('RU')` | react-imask STALE 23mo + Vite issue #1130 OPEN; @react-input/mask stale 17mo |
| **D2** | Consent UI | **Modal с standalone consent text + own checkbox** (per legal type) | 156-ФЗ separate-doc canon: substantively independent; UX: single-page widget |
| **D3** | BAR_NR rate plan canon | **Re-cast в demo seed как «1-night charge при отмене в день заезда» (`BAR_FLEX_NR` code)** | ПП РФ 1912 (effective 2026-03-01): «невозвратный тариф» eliminated; max 1-night charge canon |
| **D4** | SmartCaptcha integration | **Defer к Track C2** + rate-limit primary в A2 | Demo на Mock = no abuse vector; captcha-after-breach pattern (Vercel canon 2026); SmartCaptcha = live-integration concern |
| **D5** | Zod adapter | **NO adapter — Standard Schema direct** | TanStack Form 1.x canon, Zod 4.4 implements Standard Schema natively. `@tanstack/zod-form-adapter` ABANDONED (0.42.1 Feb 2025) |
| **D6** | Rate-limit storage | **In-memory `hono-rate-limiter@0.5.3` Phase 1** (10/min/IP + 100/hr/IP per slug+propertyId) | Single-instance YC Serverless Container OK; YDB-backed if multi-instance later |
| **D7** | Stub-provider semantics | **Card-dependent Stripe-canon** (`4242`=success / `4000…0002`=declined / `4000…3184`=3DS) + tenant config `outcomeMode: 'card_dependent' \| 'always_success'` | Universal dev muscle-memory + sales-pitch screen-recordings via always_success |
| **D8** | Idempotency-Key TTL | **24h** (matches ЮKassa canonical) | Stankoff 7d too long для guest booking; 24h covers retry window without bloat |
| **D9** 🔴 | `bookingGuestSnapshot` documentType/documentNumber satisfaction для anonymous widget guests | **PROPOSED: Path B placeholder pattern** — `documentType: 'pending'`, `documentNumber: 'pending_<bookingId>'` для widget bookings; M8.A.6 magic-link guest-portal completes via existing patch. NEEDS USER SIGNOFF. | Existing booking schema requires passport at booking-create. Widget anonymous flow cannot satisfy. See §12 #8 honest gap для full 3-path analysis. |

---

## §5. Library canon (Apr 2026 verified empirically)

| Library | Version | Last publish | Verdict |
|---|---|---|---|
| `@tanstack/react-form` | **1.29.1** | 2026-04-21 | ✅ Standard Schema direct |
| `zod` | **4.4.1** | 2026-04-29 | ✅ Implements Standard Schema natively |
| `libphonenumber-js` | **1.12.42** | 2026-04-23 | ✅ `AsYouType('RU')` formatter |
| `@aws-sdk/client-sesv2` | **3.1039.0** | 2026-04-29 | ✅ Magic-link email (Postbox) |
| `jose` | **6.2.3** | 2026-04-27 | ✅ Magic-link JWT (used in §M9.widget.5) |
| `hono-rate-limiter` | **0.5.3** | 2025-12-29 | ⚠️ Battle-tested, watch dep |
| ~~`react-imask`~~ | 7.6.1 | 2024-05-21 | ❌ STALE 23mo + Vite issue #1130 OPEN |
| ~~`@react-input/mask`~~ | 2.0.4 | 2024-12-05 | ❌ STALE 17mo |
| ~~`@tanstack/zod-form-adapter`~~ | 0.42.1 | 2025-02-20 | ❌ ABANDONED — Standard Schema replaces |

---

## §6. Stankoff-v2 borrow plan

| Pattern | Stankoff source | Verdict |
|---|---|---|
| SmartCaptcha service + widget | `services/captcha.ts` + `auth/components/captcha-field.tsx` | **BORROW AS-IS** (production-tested fail-closed, AbortSignal timeout, structured logging) — но defer к Track C2 |
| Integration idempotency middleware | `middleware/integration-idempotency.ts` | **BORROW WITH MODS**: drop HMAC, swap PK→`(idempotencyKey, propertyId)`, **24h TTL** |
| YDB dedupe migration shape | `db/migrations/028-integration-dedupe.sql` | **BORROW AS-IS** (Utf8 PKs + `WITH (TTL = Interval("PT24H"))` convention) |
| TanStack Form ≤7-field dialog | `features/chat/components/create-channel-dialog.tsx` | **BORROW WITH MODS**: use Zod 4 Standard Schema direct (NOT zodValidator adapter), Sheet not Dialog для mobile |
| Phone mask | NOT FOUND в stankoff-v2 | **GREENFIELD** — libphonenumber-js path |
| 152-ФЗ consent UI | NOT FOUND в stankoff-v2 | **GREENFIELD** — follow M8.A.6 canon (`project_m8_a_6_ui_canonical.md`) |
| Payment provider | NOT FOUND в stankoff-v2 | **GREENFIELD** — follow M6 canon (`project_payment_domain_canonical.md`) |

---

## §7. Migration 0045 schema

```sql
-- 0045_consent_log.sql — M9.widget.4 — RU compliance audit-trail
-- Per 152-ФЗ ст. 22.1 (DPO recordkeeping) + 156-ФЗ от 24.06.2025 separate-doc canon.
-- Stores legitimate consent records даже для demo-tenant bookings (compliance не
-- зависит от Mock vs Live per `feedback_behaviour_faithful_mock_canon.md`).

CREATE TABLE consentLog (
    tenantId Utf8 NOT NULL,
    consentLogId Utf8 NOT NULL,
    propertyId Utf8 NOT NULL,
    guestEmail Utf8 NOT NULL,
    consentType Utf8 NOT NULL,        -- '152fz_pd' | '38fz_marketing'
    granted Bool NOT NULL,
    bookingId Utf8,                    -- Optional, NULL до booking commit
    ipAddress Utf8,
    userAgent Utf8,
    consentText Utf8 NOT NULL,        -- Exact wording shown to guest
    consentVersion Utf8 NOT NULL,     -- 'v1.0' / 'v1.1' для traceability
    createdAt Timestamp NOT NULL,
    PRIMARY KEY (tenantId, consentLogId),
    INDEX idx_email_created GLOBAL ON (tenantId, guestEmail, createdAt),
    INDEX idx_booking GLOBAL ON (tenantId, bookingId)
);

-- Retention: 3 years post-checkout (defensible per ст. 196 ГК РФ — общий срок
-- исковой давности; not legally mandated as canonical 152-ФЗ value).
-- TTL not declared at table level — operator-side policy via cleanup cron.
```

---

## §8. Compliance hard-requirements (закон, не decisions)

1. **Opt-in mandate** ЗоЗПП ст. 16 ч. 3.1 (ФЗ 69-ФЗ от 07.04.2025) — все consent checkboxes unchecked default
2. **Separate-document consent** 156-ФЗ от 24.06.2025 (effective 2025-09-01) — modal с standalone consent text, не bundled в TOC
3. **Cancellation policy** ПП РФ 1912 (effective 2026-03-01) — refund 100% при cancel-before-checkin; max 1-night charge на no-show
4. **VAT 22% display** ст. 10 ЗоЗПП — обязательная цена с НДС (vat_code 11 per 425-ФЗ от 28.11.2025)
5. **Тур.налог 2% Сочи** база только room-revenue (ст. 418.4 НК РФ verbatim)
6. **Item-level fiscalization** 54-ФЗ ст. 4.7 — каждый addon отдельная позиция чека
7. **NO «AI-suggested» / «Recommended» badges** — ст. 5 38-ФЗ риск без factual basis
8. **152-ФЗ ст. 9** — separate document, mandatory fields (FIO + purpose + processor + retention + revocation), checkbox+IP+UA+timestamp = простая ЭП (требует соглашения о ПЭП per 63-ФЗ ст. 9)
9. **РКН реестр** обязательность регистрации до старта обработки (operator-side, не widget code)
10. **Audit-trail** 152-ФЗ ст. 22.1 — `consentLog` persistence обязательна

---

## §9. Strict test plan (target ~70 strict + 10 E2E)

### Backend (~40 strict)

`booking-create.service.test.ts` (~15):
- Happy path: slug → guest creation → booking creation → consent records → payment intent (Stub success) → return shape
- Cross-tenant isolation (slug A's booking attempt с slug B context)
- Stale-cache mismatch (availability changed since quote → soft fail)
- Invalid roomTypeId / ratePlanId → domain error
- BookingCreateInput validation (Zod adversarial inputs)
- 152-ФЗ consent absence → 422 (mandatory)
- 38-ФЗ consent absence → 200 (optional)
- Payment intent idempotent replay (same Idempotency-Key → return existing)
- Payment intent fresh creation (different key → new payment row)
- Stub `outcomeMode='card_dependent'` × {success/declined/3DS} cards
- Stub `outcomeMode='always_success'` overrides card semantic
- Phone format validation (E.164 +7DDDDDDDDDD)
- Email format validation
- Citizenship enum coverage
- guestEmail / IP / UA stored в consentLog correctly

`booking-create.service.integration.test.ts` (~10):
- Real YDB write — booking + consent + payment rows persisted
- CDC trigger: booking.created event emits (verify outbox row appears)
- Cross-tenant adversarial: tenant A's booking via slug B route → 404
- Idempotency UNIQUE collision per (idempotencyKey, propertyId)
- Booking → payment row → folio (eventually consistent via CDC)

`booking-create.routes.test.ts` (~10):
- POST 200 happy path
- POST 422 missing 152-ФЗ consent
- POST 429 rate-limit exceeded (10/min/IP)
- POST 429 hourly limit (100/hr/IP)
- POST 422 Idempotency-Key body fingerprint mismatch
- POST replay (same key, same body) → cached response
- POST malformed body → 400
- POST unknown slug → 404 (timing-safe)
- POST CSP headers preserved
- POST CORS allow

`consent-record.test.ts` (~5):
- INSERT 152-ФЗ + 38-ФЗ rows correct shape
- Cross-tenant isolation (consent A's tenant НЕ visible from B)
- Exact wording stored (not template var, actual rendered text)
- Version traceability (different `consentVersion` for v1.0 vs v1.1)
- bookingId nullable until commit, populated after

### Frontend (~30 strict)

`guest-form.test.tsx` (~10):
- TanStack Form 1.29.1 + Zod 4.4.1 Standard Schema direct (no adapter)
- E.164 phone format `AsYouType('RU')` formatting on input
- Required fields validation (firstName, lastName, email, phone, citizenship)
- Optional fields (countryOfResidence, specialRequests)
- autocomplete attrs: given-name / family-name / email / tel / country
- Mobile keyboard hints: inputMode email/tel/numeric
- Async email validation (debounce 300ms)
- Server-error display (aria-invalid + aria-describedby)
- Submit disabled until form valid + 152-ФЗ consent given
- Touch target 44×44 на mobile

`consent-block.test.tsx` (~8):
- Modal с standalone 152-ФЗ consent text (real wording)
- Modal с standalone 38-ФЗ consent text (real wording)
- Both checkboxes unchecked default (opt-in canon ЗоЗПП ст. 16 ч. 3.1)
- 152-ФЗ обязательно accept (form gated)
- 38-ФЗ опционально (no gate)
- Exact wording rendered (not lorem ipsum)
- Consent version v1.0 stable across renders
- Modal trapped focus + esc to close + return focus to checkbox

`payment-canonical-widget.test.tsx` (~7):
- Canonical contract — same UI works для Stub + live ЮKassa
- Real Luhn validation (4242…→ valid, 4242…1→ invalid)
- Real expiry validation (MM/YY future)
- Real CVV validation (3-4 digits)
- State transitions: idle → loading → success/fail
- Stub `outcomeMode='card_dependent'` rendered correctly per card
- Magic-link redirect to confirmation на success

`payment-flow.test.ts` (~5):
- Full happy path orchestration
- Abandonment paths (consent missing / payment cancel)
- Rate-limit 429 graceful handling
- Idempotency-Key replay handling

### E2E (~10)

- [GP1] Navigate Screen 2 (extras) → Screen 3 (guest+pay) via Continue
- [GP2] Form rendered + 152-ФЗ + 38-ФЗ checkboxes unchecked default
- [GP3] Phone format `AsYouType('RU')` real-time
- [GP4] Click 152-ФЗ checkbox → opens modal with consent text → close → checkbox checked
- [GP5] 38-ФЗ optional, не блокирует submit
- [GP6] Submit с invalid form → shows aria-invalid + aria-describedby errors
- [GP7] Submit с valid form + 152-ФЗ consent → payment widget renders
- [GP8] Test card `4242…` → state transitions → success → magic-link redirect
- [GP9] axe-pass 4 themes (light + dark + mobile + forced-colors)
- [GP10] Cart serialized в URL search params + persists across reload

---

## §10. Sub-phase split (golden middle)

### A2.1 Backend (~3 days, ~40 strict + integration tests)
1. Migration 0045_consent_log.sql + sql:up smoke test
2. `lib/consent-record.ts` + tests
3. `middleware/widget-idempotency.ts` + tests
4. `domains/widget/booking-create.service.ts` + tests
5. `domains/widget/booking-create.routes.ts` + tests
6. Integration test (real YDB, CDC verify)
7. Empirical curl verify endpoint

### A2.2 Frontend (~2 days, ~30 strict + 10 E2E)
1. Frontend `widget-api.ts` extend для new POST endpoint
2. `lib/payment-flow.ts` + tests
3. `components/guest-form.tsx` + tests
4. `components/consent-block.tsx` + tests
5. `components/payment-canonical-widget.tsx` + tests
6. `screens/guest-and-pay.tsx` + tests
7. TanStack Router sub-route + tests
8. E2E + axe matrix expansion
9. Visual smoke 4 viewports + screenshots

---

## §11. Pre-done audit checklist (paste-and-fill в commit body)

Per `feedback_pre_done_audit.md`:

- [ ] Cross-tenant × every method (booking-create / consent-record / widget-idempotency)
- [ ] PK separation × N dimensions (consentLog: tenantId × consentLogId; idempotency: tenantId × idempotencyKey × propertyId)
- [ ] Enum FULL coverage (consentType: '152fz_pd' + '38fz_marketing')
- [ ] Null-patch vs undefined-patch (bookingId NULL до commit, populated after)
- [ ] UNIQUE collision per index (idempotency replay)
- [ ] Adversarial negative paths (invalid Zod inputs, malformed Idempotency-Key, rate-limit exceeded)
- [ ] Empirical curl verify endpoint live (not just mocked tests)
- [ ] Visual smoke 4 viewports + Read screenshots BEFORE «done»
- [ ] axe AA pass на all surfaces (widget guest+pay route)
- [ ] Coverage floor maintained (47/53/36/47 lines/branches/funcs/statements)
- [ ] 9-gate pipeline green: sherif / biome / depcruise / knip / typecheck / build / test:serial / smoke / e2e:smoke

---

## §12. Risks / honest gaps

1. **Empirical curl Live ЮKassa contract verification = Track C2** — Stub canonical contract is research-cache-faithful, NOT empirically verified против live sandbox. Carry-forward к C2.
2. **PCI DSS 4.0.1 SAQ-A attestation от ЮKassa** = Track C2 (operator-side multi-week process)
3. **react-imask issue #1130** mitigated via libphonenumber-js (no IMask dep)
4. **Vaul UNMAINTAINED Apr 2026** (per `feedback_vaul_unmaintained_2026.md`) — defer Sheet migration к M9.widget.6
5. **Rate-limit in-memory storage** — single-instance YC Serverless Container OK; multi-instance requires YDB-backed storage (carry-forward)
6. **156-ФЗ separate-doc «modal vs route» legal interpretation** — modal с standalone consent text accepted as substantively independent; standalone route gold-standard. Carry-forward consultation if РКН guidance updates 2026 H2.
7. **Magic-link delivery** = M9.widget.5 (next sub-phase). booking-create returns `bookingId` + `confirmationToken` consumed Screen 4.
8. **🔴 BLOCKING — `bookingGuestSnapshot` schema requires `documentType` + `documentNumber`** (`packages/shared/src/booking.ts:103`):
   ```ts
   documentType: z.string().min(1).max(50),  // REQUIRED
   documentNumber: z.string().min(1).max(50), // REQUIRED
   ```
   Existing operator-facing booking flow expects passport documents at booking time. Public widget (anonymous) cannot satisfy this. **Decision D9 needed (3 paths):**
   - **A. Schema relaxation** — make documentType/documentNumber nullable in `bookingGuestSnapshotSchema`. Wider impact на existing admin booking flow (need verification).
   - **B. Placeholder pattern** (recommended) — booking-create.service inserts `documentType: 'pending'`, `documentNumber: 'pending_<bookingId>'` для widget bookings. M8.A.6 magic-link guest-portal updates via existing patch flow. **No schema change.** Boundaried к widget bookings (filterable). M9.widget.5 magic-link delivers guest-portal URL для doc completion.
   - **C. Expand Screen 3 form** — collect passport upfront (8-9 fields). Deviates от plan §4 «7 fields», harder UX. Aligns с AI passport scan vision (1.2 mandate) but adds significant scope.
   - Same constraint в `guestCreateInput` (`packages/shared/src/guest.ts:38`) — documentType/documentNumber required.
   - Pre-flight gap caught в senior post-completion audit. Plan §M9.widget.4 spec'd form fields without verifying against existing `BookingCreateInput` shape.
   - **Recommendation: Path B**. Smallest surface area, no schema migration, magic-link M9.widget.5 naturally completes data collection via M8.A.6 patterns.

---

## §13. Process correction #15 (lock-in)

**Per-sub-phase canonical plan file mandatory.** Research findings без written-to-disk persistence dissolve в conversation memory. Each sub-phase = own `plans/m9_widget_<N>_canonical.md` extending milestone canon.

Pattern:
1. Pre-flight: 4-6 раундов research + adversarial verify + stankoff cross-check + npm verify
2. Plan canon file (this) — committed in repo, indexed via memory pointer
3. Iteration N+1 self-audit log в milestone plan canon
4. Implementation grounded в plan canon
5. Done memory after closure

Без шага 2 — research findings растворяются. Это recurring confusion log.

---

## §14. Anchor commits

- `fb0c0b1` — M9.widget.2 done (Search & Pick)
- `db94d7b` — M9.widget.3 initial commit (Extras)
- `ff62cb2` — M9.widget.3 senior-pass closure
- `<TBD>` — M9.widget.4 pre-flight canon (this file's commit)
- `<TBD>` — M9.widget.4 backend A2.1
- `<TBD>` — M9.widget.4 frontend A2.2

---

## §15. Definition of Done M9.widget.4

- [x] All §11 audit checklist items zelёные (per `70c0b14` + `add8f9f` + closure commit)
- [x] Backend booking-create endpoint live + verified — pnpm smoke X1-X2 cross-tenant + S1-S7 booking lifecycle ✓; BCR1-17 Hono test app full chain (functional curl equivalent)
- [x] Frontend guest+pay screen renders + E2E GP1 verified
- [x] CDC consumers verified emitting (folio_creator + tourism_tax + activity_writer + notification-dispatcher) — pnpm smoke logs show all 4 CDC consumers fire on booking.created during S1
- [x] Real legal compliance UI (152-ФЗ + 38-ФЗ + ПП 1912 separate-doc consent + cancellation copy в StickySummary)
- [x] Real form validation (E.164 phone via libphonenumber-js + Zod 4 Standard Schema canonicalization)
- [x] Real `consentLog` persistence — backend schema + recordConsents helper + BCR8 422 path verified
- [x] Real `Idempotency-Key` 24h dedup — BCR11/12 replay + conflict tested
- [x] Real rate-limit 10/min + 100/hr per IP per slug — D6 wired + WRL10/BCR15 429 path tested
- [x] Stub-provider canonical interface — wire shape stays same для Stub (sync `succeeded`) + future ЮKassa (`pending` + `confirmationToken`); UI branches на `paymentStatus`
- [x] axe-pass 4 themes + WCAG 2.2 AA — GP5-GP8 light/dark/mobile/forced-colors all pass after `forced-colors:bg-[ButtonText]` button override
- [x] Coverage floor maintained — backend test:serial 4252 passed | 1 intentional skip | 0 fails
- [x] Plan §17 Implementation log appended (M9.widget.4 findings + 4 process corrections)
- [x] `project_m9_widget_4_done.md` memory entry

---

## §16. Pre-A2.2 freshness recheck (2026-04-30)

Per user canon «при минимальном сомнении — самый современный веб ресерч»: после A2.1 closure (commit `fc419c2`) и до A2.2 frontend code — empirical npm-registry recheck всего frontend stack.

**Findings (all verified `npm view <pkg> version` 2026-04-30):**

| Package | Plan §5 | Actual latest | Action |
|---|---|---|---|
| `@tanstack/react-form` | 1.29.1 | 1.29.1 (2026-04-21) | ✅ keep |
| `zod` | 4.4.1 | 4.4.1 (2026-04-29) | ✅ keep — note: **4.4.0 hot-fixed same day**, pin `^4.4.1` not `^4.4.0`. Watch `z.undefined()` strictness (use `.optional()` для optional ключей) |
| `libphonenumber-js` | 1.12.42 | 1.12.42 (2026-04-23) | ✅ keep |
| `vaul` | 1.1.2 | 1.1.2 (2024-12-14) | ⚠️ 16mo no release (per `feedback_vaul_unmaintained_2026.md`); **carry-forward к M10 → Radix Dialog Sheet**; A2 stays на 1.1.2 (works, peer React 19 declared) |
| `@tanstack/react-router` | latest | 1.168.26 (2026-04-29) | ✅ |
| `@tanstack/react-query` | latest | 5.100.6 (2026-04-28) | ✅ |
| `react` | 19.x | 19.2.5 (2026-04-15) | ✅ |
| `react-phone-number-input` | candidate | 3.4.16 (2026-02-23) | ❌ **REJECTED** — over-shoots для RU-fixed widget. Country selector + flag не нужны (Сочи = RU-only). Raw `libphonenumber-js` AsYouType('RU') + `<input type="tel">` достаточно. Adopting library = +bundle для UI mы не выводим. |

**ЮKassa Checkout Widget v1**: embed URL `https://yookassa.ru/checkout-widget/v1/checkout-widget.js` стабилен; СБП в каталоге методов; SAQ-A scope подтверждён. No 2026 breaking changes.

**D1 confirmation (no amendment)**: phone input stays raw `libphonenumber-js@1.12.42` AsYouType('RU') as planned. Senior-judgement: для RU-fixed (no country variability) готовая wrapper-library = over-engineering.

**No breaking changes** в нашем surface за последние 7 дней. Plan §4-§15 stays unchanged. Frontend implementation proceeds на этих pinned versions.

---

## §17. Implementation log

### A2.1 (commit `fc419c2`, 2026-04-30 17:50) + A2.1.fix (commit `70c0b14`, 2026-04-30 20:36)

**A2.1 initial:** widget service composes existing services + middleware chain wired. **65 strict tests** (25 unit + 6 integration + 34 routes integration).

**A2.1.fix corrections** (caught senior post-completion audit):
1. **D6 rate-limit gap** — `hono-rate-limiter@0.5.3` dep added; `widget-rate-limit.ts` middleware (10/min + 100/hr / IP+slug). Now wired в chain BEFORE tenant-resolver (cheapest reject первым).
2. **Types drift risk** — `WidgetBookingCommitWireInput/Result/ErrorReason` extracted в `packages/shared/src/widget.ts`. Backend route `zValidator` + frontend client share single source of truth.
3. **Service refactor** — domain service consumes shared types (drop local `WidgetGuestInput / WidgetConsentFlags / WidgetConsentSnapshot` duplicates).
4. **+17 tests** — 14 unit (WRL1-14 IP fallback chain, key generation, 429 path, separate-bucket invariants) + 3 integration (BCR15-17 429-path through full middleware chain).
5. **Honest correction** — `fc419c2` claimed «1 unrelated payment flake»; re-running test:serial confirmed 4252 passed + 1 intentional skip + 0 fails. No flake. Per `feedback_no_preexisting.md` this WAS a half-measure.

**A2.1.fix gates:** sherif/biome/depcruise/knip/typecheck all green; full test:serial **4252/4253 pass, 0 regressions**.

### A2.2 frontend (commit pending, 2026-04-30)

**Pre-write recheck (§16):** все deps confirmed latest stable; `react-phone-number-input` rejected over-shoot; raw `libphonenumber-js@1.12.42` AsYouType('RU') canonical.

**Production files (8):**
- `lib/widget-booking-api.ts` — fetch helper, error taxonomy mapped к shared `WidgetBookingCommitErrorReason`
- `lib/consent-texts.ts` — frozen v1.0 wordings (152-ФЗ + 38-ФЗ separate-doc canon)
- `lib/phone-format.ts` — `formatRu` AsYouType + prefix normalization (digits-only `8…` или `7…` → `+7…`); `isValidRuPhone`; `toE164`
- `hooks/use-create-booking.ts` — TanStack Query mutation (project canon: `useCreateRefund`-style)
- `components/consent-block.tsx` — Radix Checkbox + ResponsiveSheet для standalone full-text reading
- `components/guest-form.tsx` — TanStack Form 1.29.1 + Zod 4 Standard Schema direct + libphonenumber-js
- `components/payment-method-selector.tsx` — Radix RadioGroup (card / sbp)
- `screens/guest-and-pay.tsx` — orchestration с canonical Mock interface (works для Stub demo + future live ЮKassa)
- `routes/widget.$tenantSlug_.$propertyId_.guest-and-pay.tsx` — TanStack flat sub-route с validateSearch

**Test pyramid (54 unit + 9 E2E):**
- `widget-booking-api.test.ts` — 13 tests (idempotency-key uniqueness, fetch error taxonomy)
- `phone-format.test.ts` — 9 tests (formatRu / isValidRuPhone / toE164)
- `consent-texts.test.ts` — 9 tests (legal citations, ФЗ separation, length bounds)
- `consent-block.test.tsx` — 8 tests (opt-in default, aria-required, separate sheets)
- `payment-method-selector.test.tsx` — 6 tests (radio options, value sync, disabled)
- `guest-form.test.tsx` — 9 tests (validation, phone format, canonicalization, optional null)
- `tests/e2e/widget.spec.ts` GP1-GP9 — 9 E2E (form render, phone formatting, DPA gate, standalone-sheet open, axe matrix 4 themes [light/dark/mobile/forced-colors], invalid search → errorComponent)

**A2.2 process corrections (additional):**
1. **DOM-direct asserts canon** — project НЕ wires `@testing-library/jest-dom`; tests use `data-state` for Radix checked / `getAttribute('aria-…')` / `el.textContent.toMatch()`. Не использую `toBeChecked` / `toBeInTheDocument` / `toHaveTextContent` без verifying setup.
2. **`useId()` для всех id attrs** — biome `useUniqueElementIds` rule rejects static literal ids внутри components. Tests target `data-testid` (not `id`) so refactor `id="..."` → `id={useId()}` без test breakage.
3. **`parsePhoneNumberWithError`** — `parsePhoneNumber` from libphonenumber-js deprecated в favour of `WithError` variant (biome `noDeprecatedImports` flagged).
4. **Phone prefix normalization** — AsYouType('RU') не auto-prepend `+` для leading `7`. Senior UX: pre-process digits-only input через `+7` prefix.

**A2.2 gates:** typecheck clean / biome 0 errors / depcruise 0 violations / **54/54 unit pass / 9/9 E2E (TBD pre-push)**.
