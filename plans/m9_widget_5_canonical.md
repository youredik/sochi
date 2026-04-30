# M9.widget.5 — Screen 4 Confirmation + Magic-link + Email Voucher (canonical sub-phase plan)

**Дата:** 2026-04-30
**Track:** A3 (per `plans/ROADMAP.md`) — closes Боль 2.3 (continuing) widget surface. Screen 4 после payment success: confirmation summary + email voucher с .ics + magic-link для guest portal.
**Scope reframe:** demo surface на Postbox/Mailpit factory; live ЮKassa already Stub'd через A2 closure. Behaviour-faithful Mock canon: same UI работает с обоими (Stub demo + future live Postbox). Live-flip = factory binding swap.
**Canonical guard:** `feedback_behaviour_faithful_mock_canon.md` — Mock = полнофункциональный поставщик с canonical interface.
**Research:** R1 (4 agents broad 2026-04-30+) + R2 adversarial (2 agents — security attacks + RU compliance) + R3 strict (1 agent freshness verify ≥2026-04-15) + stankoff-v2 cross-check + npm empirical verify 2026-04-30. **80+ findings, 30+ corrections к baseline `m9_widget_canonical.md` §M9.widget.5.**

---

## §1. North-star alignment

**Demo surface canon**: один codebase обслуживает demo + production. Live-flip = factory binding swap, **ZERO domain changes**. Same backend code:
- **Demo тенант** (`mode='demo'`): Mailpit catches email + .ics displays in dev UI; magic-link clickable but не leaves dev environment
- **Production тенант** (`mode='production'`): Postbox sends real email через verified sender domain (defer'ed M10/M11 на real DKIM); same magic-link flow

**Что строится в M9.widget.5 (Track A3):**
- Real magic-link service (jose 6.2.3 HS256 per-tenant, two-step GET→POST consume для prefetch DoS защита)
- Real email voucher (react-email 6.0.5 templates, RU-strict transactional, NO cross-sell)
- Real .ics calendar attachment (ical-generator 10.2.0 + Europe/Moscow VTIMEZONE)
- Real guest portal (cookie-auth `__Host-` prefix Lax→Strict upgrade, view + cancel actions)
- Real timing-safe find-by-ref-email (Promise.allSettled + Math.max padding pattern)
- Real audit trail (`magicLinkLog` + `consentLog` cross-link для GDPR/152-ФЗ)

**Что defer'ится (carry-forward):**
- Postbox real DKIM/sender-domain verification → Track B6 / M11
- @react-pdf/renderer voucher PDF off-hot-path (memory leak issue #3051) → defer download until guest portal click; render in worker process с recycle. M9.widget.5 ship voucher info as HTML + .ics только; PDF download → guest portal action with async render.
- Live ЮKassa webhook на payment.succeeded triggering email send → already wired через `notification-dispatcher` CDC consumer (per `project_payment_domain_canonical.md`)
- Date modification (re-quote) flow — defer M11 (industry canon = cancel-and-rebook, complex orchestration)
- РКН реестр operator field на tenant onboarding → М10 (M9.widget.5 не блокер)

---

## §2. Integration map — что widget hooks (NO modifications к existing services)

| Existing service | Used by widget.5 |
|---|---|
| `domains/booking/booking.service.ts` | `getById()` для confirmation + `cancel()` для guest portal action |
| `domains/payment/payment.service.ts` | `getStatus()` для confirmation page polling |
| `domains/widget/booking-create.service.ts` | already returns `bookingId` + `paymentId` in commit response (per A2.2 wire shape) |
| `notification-dispatcher` (CDC consumer) | already wired — fires on `booking.created` event; will dispatch confirmation email через нашу new template |
| `lib/email/factory.ts` (Postbox/Mailpit/Stub) | already wired через M7.fix.2; we add new template type `booking-confirmation` |
| `tenant-resolver.ts` | per-tenant magic-link secret + per-tenant sender email |

**Я НЕ создаю**: payment status polling (existing), CDC consumer for email dispatch (already triggers), guest data (existing schema), booking cancel logic (booking.service.cancel exists per `project_payment_domain_canonical.md`).

**Я создаю**:
- New table `magicLinkToken` (per-tenant, single-use canonical)
- New service `magic-link.service.ts` (issue + verify + consume)
- New routes `widget/booking-find.routes.ts` + `widget/magic-link-consume.routes.ts` + `booking/guest-portal.routes.ts`
- New template `email/booking-confirmation.tsx` (react-email)
- New `lib/ics-generator.ts` (ical-generator wrapper)
- New frontend screen `widget/screens/confirmation.tsx`
- New frontend route `booking.$jwt.tsx` (magic-link landing)
- New frontend route `booking.guest-portal/_authenticated.tsx` (cookie-gated)
- New frontend hook `useGuestSession.ts`

---

## §3. Что реально пишется

### Backend (8 new files + 1 migration)

| File | Purpose |
|---|---|
| `db/migrations/0046_magic_link_token.sql` | NEW table — per-tenant magic-link tokens с `consumed_at` для атомарной single-use enforcement |
| `lib/magic-link/secret.ts` | per-tenant HS256 secret resolver (Phase 1: column в `organizationProfile.magicLinkSecret` с lazy back-fill для existing tenants; Phase 2: Lockbox carry-forward) |
| `lib/magic-link/jwt.ts` | jose 6.2.3 thin wrapper — `signMagicLinkJwt()` + `verifyMagicLinkJwt()` с `crypto.timingSafeEqual` for HMAC inside jose |
| `domains/widget/magic-link.service.ts` | `issue(claims, scope, ttl)` / `verify(jwt)` (read-only, returns claims) / `consume(jti)` (atomic UPDATE WHERE consumed_at IS NULL → 410 Gone if zero rows) |
| `domains/widget/booking-find.routes.ts` | POST `/api/public/widget/{slug}/booking/find` (timing-safe — always 200 OK + Promise.allSettled padding) — issues magic-link + dispatches email |
| `domains/widget/magic-link-consume.routes.ts` | GET `/api/public/booking/jwt/:jwt/render` (renders confirm-button page WITHOUT consuming) + POST `/api/public/booking/jwt/:jwt/consume` (atomic consume + Set-Cookie + 302 redirect) |
| `domains/booking/guest-portal.routes.ts` | `_authenticated` group: GET `/booking/guest-portal/:bookingId` (view) + POST `/booking/guest-portal/:bookingId/cancel` (cancel action with ПП-1912 enforcement) |
| `lib/email/booking-confirmation.tsx` | react-email 6.0.5 template — HTML + plain-text fallback + .ics attachment integration |
| `lib/email/render.ts` | wraps `@react-email/render` для unified send flow через email factory |
| `lib/ics-generator.ts` | ical-generator 10.2.0 thin wrapper — `generateBookingIcs(booking)` returns `{ filename, content, contentType }` для SES v2 attachment |
| `middleware/guest-session.ts` | Hono middleware — `getSignedCookie('__Host-guest_session')` → set `c.var.guestSession = { bookingId, scope, exp }` или 401 |
| `middleware/widget-rate-limit-find.ts` | Tuple-key rate-limit `(email_normalized, booking_ref)` — extends existing `widget-rate-limit.ts` для find-flow |

### Frontend (5 new files)

| File | Purpose |
|---|---|
| `screens/confirmation.tsx` | Screen 4 orchestration: booking summary + .ics download + Add-to-calendar buttons + email-sent confirmation + magic-link explanation |
| `components/booking-summary.tsx` | shared между confirmation + guest-portal — dates, guests, room, payment status, total с tabular-nums, ПП-1912 cancellation copy |
| `components/calendar-add.tsx` | Google Calendar URL + Apple webcal:// + Outlook URL + .ics download. Yandex Calendar: ics-only (no public URL pattern verified 2026-04-30) |
| `routes/widget.$tenantSlug_.$propertyId_.confirmation.tsx` | TanStack flat sub-route с validateSearch (bookingId + paymentId from A2 commit response) |
| `routes/booking.$jwt.tsx` | Magic-link landing — fetches `/render` → shows confirm-button → POSTs to `/consume` → on 200 receives Set-Cookie + redirects к guest portal |
| `routes/booking._authenticated.guest-portal.tsx` | Layout route (TanStack `_authenticated` canon) с `beforeLoad` → проверяет cookie via `/api/public/guest-session/whoami` → if no session redirect к `/booking/find-by-ref-email` |
| `routes/booking.guest-portal.$bookingId.tsx` | Guest portal view + Cancel button с ПП-1912 disclosure copy |
| `routes/booking.find-by-ref-email.tsx` | Form: reference + email → POST `/booking/find` (always 200 OK) + UI shows «Если данные верны, мы отправили письмо» |
| `hooks/use-guest-session.ts` | TanStack Query — `whoami()` returns `{ bookingId, scope }` или null |

---

## §4. 9 Decisions (final, post R1+R2+R3)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | Magic-link single-use enforcement | **Two-step GET-render → POST-consume** для mutate (cancel) + `allowedAttempts: 5` для view-only voucher download | etodd.io 2026-03-22 + R3 verified: industry canon non-uniform (Stytch=device intel, Clerk=same-device, BetterAuth=`allowedAttempts`). У нас нет device-intel infra → two-step + multi-attempt safest. POST never prefetched by Apple MPP / Slack unfurl / Outlook SafeLinks. |
| **D2** | JWT TTL | **mutate (cancel)=15min** + **view (voucher)=24h** + cookie session = 7 days | Industry consensus 2026-04: 10-15min mutate; 24h view = trade-off (longer = email scanner replay window, но guest UX > security за view-only data). NEVER 7d JWT. |
| **D3** | Cookie scheme | **`__Host-guest_session`** — Path=/, Secure, HttpOnly, **SameSite=Lax on first set → Strict-on-next-request** rotation | R3 verified: Strict drops cookie на cross-site magic-link click (email→browser nav). Lax-then-Strict pattern: set Lax in /consume response, on next authenticated request rotate к Strict. `__Host-` prefix forbids `Domain=` → per-host isolation, defends subdomain XSS bypass. |
| **D4** | Hono version pin | **`hono ^4.12.16` (caret accepted)** | R3 verified: 5 cookie/jsx/bodyLimit GHSAs April 2026 (GHSA-9vqf 2026-04-30 + GHSA-69xw 2026-04-30 + GHSA-458j 2026-04-15 + GHSA-r5rp 2026-04-07 + GHSA-26pp 2026-04-07). Caret `^4.12.16` is functionally equivalent для security purposes (≥4.12.16 < 5.0.0 — все patches present). Originally drafted as EXACT pin — caret accepted post-install для consistency с rest of project. Currently installed 4.12.15 → bump same commit (4.12.16). |
| **D5** | Token in URL | `?token=<jwt>` на GET render → 302 → POST consume → Set-Cookie + 302 → `/booking/guest-portal/{id}` | OWASP risk mitigated by: (a) `Cache-Control: no-store` на render endpoint, (b) `Referrer-Policy: no-referrer` на consume redirect, (c) NGINX/YC ALB log scrubber strips `?token=*` (mark in `nginx.conf` carry-forward; M9.widget.5 ship clean code path) |
| **D6** | Timing-safe find-by-ref-email | `Promise.allSettled([dbQuery, sleep(800)]) + Math.max(0, 800-elapsed) padding` + always 200 OK + same body shape | Cloudflare Workers canon + Laravel timeboxing pattern. YDB query latency varies (cold tablet 200ms / warm 5ms) — fixed setTimeout не constant-time. |
| **D7** | Rate-limit key | `(emailNormalized, bookingRef)` tuple — 5 req/15min — extends existing `widget-rate-limit.ts` | Mobile NAT (МТС/Билайн) = 1000+ subscribers за 1 IP → IP-only blocking false-positives legitimate guests. Tuple key requires attacker to know valid (email, ref) combo. |
| **D8** | .ics library | **`ical-generator@10.2.0`** + `@touch4it/ical-timezones` для VTIMEZONE | ics@3.12.0 NO native VTIMEZONE → Outlook strict-mode break. ical-generator native Europe/Moscow + Luxon-friendly + 2026-04-17 release active. |
| **D9** | Email template engine | **`react-email@^6.0.5`** unified package + `@react-email/render@2.0.8` `toPlainText()` separate utility | Latest 2026-04-28 (5 patches in 13 days = active). Tailwind v4 + dark-mode + React 19.2. Deprecates `@react-email/components` v0.x. **Critical R3 correction (2026-04-30)**: `render(component, { plainText: true })` is **DEPRECATED** since `@react-email/render@1.2.0` (Aug 2025); canonical 2026 = separate `toPlainText(component)` utility. |
| **D10** | PDF voucher rendering | **Defer M11+** | `@react-pdf/renderer` persistent memory leak issues #2217 #3051 unresolved 2026-04-30. M9.widget.5 ships voucher as HTML email body + .ics attachment ONLY. Guest portal «Download voucher» button → М11 async-worker pattern. |
| **D11** | RU compliance — voucher email content | **Strict transactional** — NO cross-sell, NO marketing footer, NO tracking pixel, NO unsubscribe link | 38-ФЗ ст. 18 (ред. 2025-10-27): cross-sell («Часто берут также») = реклама → требует prior consent. Pure transactional carve-out: bookingRef + dates + guest + sum + magic-link button + property contacts + legal footer (ИНН/ОГРН тенанта). |
| **D12** | ПП РФ 1912 cancel boundary | `now < endOfDay(checkInDate, 'Europe/Moscow')` → 100% refund; else (no-show / day-of cancel) → max 1-night charge | Verbatim п. 16: «до дня заезда» = до 23:59 предыдущих суток (calendar boundary). NOT 18:00 hotel-policy time, NOT check-in 14:00 time. |
| **D13** | 152-ФЗ data deletion conflict с 109-ФЗ | UI shows «Удалить мои данные» с pre-confirmation modal disclosing retention overrides (миграционные = 1 year post-checkout / чеки 5 years / accounting 5 years). Soft-delete + hold для legitimate retention. SLA UI promise = «До 10 рабочих дней (закон)», internal target ≤72h. | 152-ФЗ ст. 14 ч. 2 + ст. 21 ч. 3 (10 раб.дней) BUT 152-ФЗ ст. 6 ч. 1 п. 2 — legal-basis override (compliance с другим законом). |

---

## §5. Library canon (Apr 30 2026 verified empirically `npm view`)

| Library | Version | Last publish | Verdict | Reason |
|---|---|---|---|---|
| `jose` | **6.2.3** | 2026-04-27 | ✅ pin | HS256 + crypto.timingSafeEqual internal |
| `hono` | **>=4.12.16 EXACT** | 2026-04-30 | ⚠️ BUMP from 4.12.15 | 5 GHSAs Apr 2026 inc. cookie + bodyLimit + jsx |
| `ical-generator` | **10.2.0** | 2026-04-17 | ✅ adopt | native VTIMEZONE Europe/Moscow + Luxon-friendly |
| ~~`@touch4it/ical-timezones`~~ | 1.9.0 | 2025-10-22 (npm); code frozen 2023-01 | ❌ REJECT — STALE 2.5 years (R3 verified 2026-04-30) | tzdb code stale; no fresher commits since 2023 |
| `timezones-ical-library` | **2.2.0** | 2026-04-29 | ✅ adopt — companion для ical-generator VTIMEZONE | active maintainer (add2cal — Add to Calendar Button ecosystem); PR #94 merged 2026-04-29 |
| `node-ical` | **0.26.0** | 2026-04-03 | ✅ devDep | round-trip parser CI tests |
| `react-email` | **^6.0.5** | 2026-04-28 | ✅ adopt (unified package, deprecates `@react-email/components` v0.x) | |
| `@aws-sdk/client-sesv2` | **3.1040.0** | 2026-04-30 | ✅ bump from 3.1039.0 (already in project) | SES v2 native Attachments API (gained 2025-04-04) |
| `@react-pdf/renderer` | 4.5.1 | 2026-04 | ❌ defer M11+ | persistent memory leak issues #2217 #3051 |
| `hono-rate-limiter` | 0.5.3 | 2025-12-29 | ⚠️ stale 4mo BUT canonical baseline | no v0.6 exists; carry-forward if ships before M10 |
| `@tanstack/react-router` | 1.169.0 | 2026-04-30 | ✅ verified | `_authenticated` layout-route + `beforeLoad` canon |
| `@tanstack/react-query` | 5.100.6 | 2026-04-28 | ✅ keep | |
| `zod` | ^4.4.1 | 2026-04-29 | ✅ keep | |
| `better-auth` | ^1.6.9 | 2026-04-24 | ✅ keep | NOT used for guest magic-link (separate flow per §6 borrow plan) |

REJECTED:
- `ics@3.12.0` — no native VTIMEZONE (Outlook strict-mode break)
- `puppeteer-core` / `pdf-lib` для PDF — defer; React-PDF leak issues
- `nodemailer` — мы используем AWS SDK v3 SESv2Client (Postbox-compatible)

---

## §6. Stankoff-v2 borrow plan (cross-check 2026-04-30)

| Pattern | Stankoff source | Verdict |
|---|---|---|
| **Better Auth `magicLink()` plugin (employee auth)** | `apps/backend/src/auth.ts:379-404` | **NOT BORROWED** — BA tied to user account creation. Widget guests ≠ user records. We build parallel custom magic-link flow на jose 6.2.3 (NOT BA plugin). |
| **AWS SES v2 against Yandex Postbox** | `apps/backend/src/services/email/email.ts:26-106` | **BORROW PATTERN** — already в нашем проекте `lib/email/factory.ts`. Verify SDK v3 SES v2 Attachments API still matches stankoff usage. |
| **`crypto.timingSafeEqual` + Buffer-byte compare** | `apps/backend/src/middleware/integration-api-key.ts:56-58` | **BORROW AS-IS** — same length-check gate + Buffer conversion canon. Apply в `magic-link.service.verify()` для secret compare. |
| **Better Auth native rate-limit** | `apps/backend/src/auth.ts:102-122` | **NOT BORROWED** — мы используем `hono-rate-limiter` 0.5.3 для guest flow (canonical в M9.widget.4). Tuple-key extension в M9.widget.5. |
| **TanStack Router `beforeLoad` auth gate** | `apps/frontend/src/routes/_app.tsx:11-31` + `require-org-admin.ts:24-30` | **BORROW WITH MODS** — pattern same; replace `requireOrgAdmin` semantic с `requireGuestSession` (cookie-based, single-resource scope vs full account auth). |
| **`.ics` calendar attachment** | NOT FOUND | **GREENFIELD** — ical-generator 10.2.0 + Europe/Moscow VTIMEZONE |
| **PDF generation** | NOT FOUND | **GREENFIELD (deferred M11)** |
| **Voucher / invoice email template** | NOT FOUND (stankoff has `templates.ts` для auth emails — invitation/verification/magic-link/password-reset, NO voucher) | **GREENFIELD** — react-email 6.0.5 |

---

## §7. Migration 0045 schema

**Correction 2026-04-30 (post-canon empirical recon):** plan canon initially numbered 0046, но latest existing migration = 0044 (M9.widget.4 reused existing `consentLog` from `0001_init.sql:431`, no new migration committed). Actual migration = **0045**.

**Correction 2026-04-30:** plan initially referenced `tenant.magicLinkSecret` — actual schema: Better Auth `organization` table (id/name/slug/logo/metadata/createdAt) + HoReCa-specific `organizationProfile` (1:1 с organization.id, holds inn/taxForm/plan/dpaVersion/etc). Per-tenant config column → `ALTER TABLE organizationProfile`.

```sql
-- 0045_magic_link_token.sql — M9.widget.5 — single-use magic-link tokens
-- Stateful single-use enforcement (atomic UPDATE WHERE consumedAt IS NULL).
-- Per-tenant — organizationProfile.magicLinkSecret signs JWT, table records consumption.

CREATE TABLE IF NOT EXISTS magicLinkToken (
    tenantId            Utf8 NOT NULL,
    jti                 Utf8 NOT NULL,            -- UUID v7 (sortable for index pruning)
    bookingId           Utf8 NOT NULL,            -- subject of token
    scope               Utf8 NOT NULL,            -- 'view' | 'mutate'
    issuedAt            Timestamp NOT NULL,
    expiresAt           Timestamp NOT NULL,
    consumedAt          Timestamp,                -- NULL = active; non-NULL = consumed
    consumedFromIp      Utf8,                     -- audit (152-ФЗ ст. 22.1)
    consumedFromUa      Utf8,                     -- audit
    issuedFromIp        Utf8,                     -- audit (для «consume from different IP» admin alert)
    attemptsRemaining   Int32 NOT NULL,           -- D1: view=5, mutate=1
    PRIMARY KEY (tenantId, jti),
    INDEX idxMagicLinkBooking GLOBAL SYNC ON (tenantId, bookingId),
    INDEX idxMagicLinkExpires GLOBAL SYNC ON (tenantId, expiresAt)
);

-- Retention: 30 days post-expiry (audit window). Cleanup cron M11+.
-- Per-tenant magic-link signing secret. 32-byte random, base64-encoded.
-- Phase 1: column-stored on organizationProfile (Phase 2 Track B5: Lockbox).
ALTER TABLE organizationProfile ADD COLUMN magicLinkSecret Utf8;
```

**Bootstrap для existing tenants** (`organizationProfile.magicLinkSecret = NULL` after migration apply):
- `lib/magic-link/secret.ts` resolver pattern: `if (profile.magicLinkSecret == null) { generate + UPDATE; return generated; }` — lazy back-fill on first read
- `afterCreateOrganization` hook (existing pattern в `auth.ts`) extends to populate column on new tenant create
- Idempotent: concurrent first-read race resolved через `UPDATE WHERE magicLinkSecret IS NULL` semantic (loser overwrite OK — value entropy identical)

---

## §8. Compliance hard-requirements (закон, не decisions)

1. **38-ФЗ ст. 18 (ред. 2025-10-27)** — transactional carve-out: pure booking confirmation НЕ требует consent + unsubscribe. **Cross-sell в email body = реклама → требует consent**. Strict transactional = booking number + dates + guest + sum + magic-link + contacts + legal footer (ИНН/ОГРН) ONLY.
2. **152-ФЗ ст. 14 ч. 2** — guest data access SLA 10 раб.дней. UI promise.
3. **152-ФЗ ст. 21 ч. 3** — data deletion request SLA 10 раб.дней. **152-ФЗ ст. 6 ч. 1 п. 2 override**: legal-basis hold (109-ФЗ migration data 1 year post-checkout, 54-ФЗ чеки 5 years).
4. **109-ФЗ migration retention** — 1 year post-checkout для иностранных гостей (ПП РФ № 9 от 15.01.2007). Disclosure mandatory.
5. **ПП РФ № 1912 от 27.11.2025 п. 16 (eff 2026-03-01)** — verbatim: «Если заказчик уведомляет об отказе от договора **до дня заезда**, исполнитель возвращает плату в полном размере. ...при опоздании или незаезде взимается плата за номер... но **не более чем за сутки**». Boundary = `endOfDay(checkInDate, 'Europe/Moscow')`. UI: cancel-button enabled с 100%-refund disclosure if `now < boundary`; else 1-night-charge disclosure.
6. **«Невозвратный тариф» eliminated** — UI element NEVER appears.
7. **152-ФЗ ст. 22.1** — DPO recordkeeping. `magicLinkToken` audit fields (issuedFromIp/consumedFromIp/UA + timestamps) satisfy this.
8. **63-ФЗ ст. 9 простая электронная подпись** — magic-link click = ПЭП requires «соглашение о ПЭП» в Terms (carry-forward к Track B7 — не M9.widget.5 blocker per existing widget consent flow).
9. **Cyrillic Subject RFC 2047** — auto-handled by AWS SDK SES v2 при `subject: "Подтверждение бронирования №..."`. NO manual encoding.
10. **iCal SUMMARY/LOCATION** — UTF-8 native (no BOM); escape `,;\` + newline. ical-generator handles.

---

## §9. Strict test plan (target ~50 strict + ~12 E2E)

### Backend (~35 strict + ~5 integration)

`magic-link/jwt.test.ts` (~6):
- Sign+verify roundtrip with HS256 per-tenant secret
- Wrong-tenant secret → reject
- Expired (TTL elapsed) → reject
- Tampered claims → reject
- `jti` UUID v7 sortable property
- Both `view` and `mutate` scope claims preserved

`magic-link.service.test.ts` (~10):
- `issue(claims, scope='view')` writes magicLinkToken row + returns JWT
- `verify(jwt)` returns claims без consume
- `consume(jti)` atomic UPDATE WHERE consumedAt IS NULL — first call succeeds, second returns null
- `consume()` decrements `attemptsRemaining` for view scope (5→4→3→2→1→0)
- `consume()` enforces single-use for mutate scope (attemptsRemaining=1)
- Concurrent `consume()` race — exactly one succeeds, other gets null (TLI retry semantics)
- Cross-tenant: tenant A's token NOT consumable from tenant B context
- Expired token → 410 Gone path
- Audit: `consumedFromIp` + `consumedFromUa` populated on success
- Issue-from-different-IP than consume → admin-alert metadata flagged (just info, не block)

`booking-find.routes.test.ts` (~7):
- Always 200 OK regardless of (ref, email) match (timing-safe canon)
- Response body shape identical for: valid match / invalid ref / invalid email / both invalid
- Response delay padding ≥800ms even for sub-100ms DB hits (Promise.allSettled + Math.max canon)
- Rate-limit tuple key `(email, ref)` — 5/15min per pair
- Rate-limit exceeded → still 200 OK (silently dropped, NOT 429)
- Cross-tenant: ref from tenant A in tenant B slug context → 200 OK + no email sent
- E.164 phone normalization on email-format-only assertion (not phone)

`magic-link-consume.routes.test.ts` (~7):
- GET `/render` returns confirm-button page WITHOUT consuming token (verify in DB consumedAt still NULL)
- GET `/render` rejects if token expired or invalid signature
- GET `/render` rejects if `attemptsRemaining=0`
- POST `/consume` consumes token (DB consumedAt populated) + returns Set-Cookie `__Host-guest_session=...; SameSite=Lax`
- POST `/consume` second call returns 410 Gone
- Cookie `Path=/` + `Secure` + `HttpOnly` + `SameSite=Lax` (verify in response headers)
- Redirect target = `/booking/guest-portal/{bookingId}`

`guest-portal.routes.test.ts` (~5):
- GET requires `__Host-guest_session` cookie
- GET returns booking details for owning bookingId only
- POST `/cancel` enforces ПП-1912 boundary: `now < endOfDay(checkInDate, 'Europe/Moscow')` → 100% refund path
- POST `/cancel` after boundary → max 1-night charge applied
- Cross-tenant via cookie tampering → 401

### Email + .ics (~8 strict + 2 integration)

`booking-confirmation.template.test.tsx` (~5):
- Renders with full data — exact-text asserts for booking#, dates, sum, magic-link URL
- Plain-text fallback identical structure (no markdown formatting drift)
- NO cross-sell strings («часто берут также» / «купите ещё ночь») — строгая negative assertion via regex
- Property contacts rendered (phone + email + address)
- Legal footer renders ИНН + ОГРН тенанта (for production tenants)

`ics-generator.test.ts` (~5):
- VEVENT generated с UID = `{bookingRef}@{tenantDomain}`
- DTSTART/DTEND с `TZID=Europe/Moscow` (multi-day check-in 14:00 → check-out 12:00)
- METHOD:PUBLISH
- VTIMEZONE block с TZOFFSETFROM=+0300 / TZOFFSETTO=+0300 (no DST)
- Cyrillic SUMMARY + LOCATION (UTF-8) renders correctly through node-ical round-trip parse
- Filename ASCII-only (`booking-{ref}.ics`, NOT `бронь.ics`)
- node-ical round-trip: parse generated ics → assert event.uid + start + end exact equal

`booking-confirmation-integration.test.ts` (~2):
- Full pipeline: booking.created CDC event → notification-dispatcher → email factory `send()` (Mailpit catches in dev) → email body includes magic-link + .ics attachment
- Mailpit attachment Content-Type=`text/calendar; method=PUBLISH; charset=utf-8`

### Frontend (~15 strict + ~12 E2E)

Frontend strict (~15):
- `booking-summary.test.tsx` — exact-value assertions (4)
- `calendar-add.test.tsx` — Google URL pattern + Apple webcal:// + Outlook URL + .ics download (4)
- `confirmation.test.tsx` — orchestration after A2 commit (3)
- `routes/booking.$jwt.test.tsx` — render→consume→redirect flow (2)
- `routes/booking._authenticated.guest-portal.test.tsx` — beforeLoad gate (2)

E2E (~12) — Playwright + axe-pass 4 themes:
- [CN1-CN3] Confirmation page renders + .ics download + Google Calendar deep-link
- [GP1-GP4] Find-by-ref-email form + always-200-OK + email arrives at Mailpit + magic-link clickable
- [GP5-GP7] Click magic-link → render-page → POST consume → cookie set → guest portal opens
- [GP8] Guest portal shows booking summary + Cancel button с ПП-1912 disclosure
- [GP9-GP10] Cancel before check-in → 100% refund path; cancel day-of → 1-night charge path
- [GP11-GP12] axe-pass 4 themes (light/dark/mobile/forced-colors)

---

## §10. Sub-phase split (golden middle)

### A3.1 Backend magic-link + .ics (~2 days, ~30 strict + 5 integration)
1. Migration 0045 (magicLinkToken + organizationProfile.magicLinkSecret) + sql:up smoke
2. `lib/magic-link/secret.ts` + tests
3. `lib/magic-link/jwt.ts` + tests
4. `domains/widget/magic-link.service.ts` + tests (atomic consume race + cross-tenant)
5. `lib/ics-generator.ts` + tests (VEVENT shape + node-ical round-trip)
6. `domains/widget/booking-find.routes.ts` + tests (timing-safe + rate-limit tuple)
7. `domains/widget/magic-link-consume.routes.ts` + tests (render + consume + Set-Cookie)
8. Empirical curl: full flow `find → email arrives Mailpit → click → render → consume → cookie set`

### A3.2 Backend email template + voucher integration (~1 day, ~10 strict + 2 integration)
9. `lib/email/booking-confirmation.tsx` (react-email 6.0.5) + tests
10. `lib/email/render.ts` (wraps `@react-email/render`) + tests
11. Wire через notification-dispatcher CDC consumer для booking.created event
12. Empirical curl: book → CDC fires → email arrives с .ics attachment в Mailpit

### A3.3 Backend guest portal + cancel (~1 day, ~5 strict + 2 integration)
13. `middleware/guest-session.ts` + tests
14. `domains/booking/guest-portal.routes.ts` (view + cancel) + tests
15. ПП-1912 boundary enforcement в booking.service.cancel (verify existing or extend)
16. Empirical curl: guest-portal flow end-to-end

### A3.4 Frontend (~2 days, ~15 strict + 12 E2E)
17. `screens/confirmation.tsx` + `components/booking-summary.tsx` + `components/calendar-add.tsx` + tests
18. `routes/widget.$tenantSlug_.$propertyId_.confirmation.tsx` + tests
19. `routes/booking.find-by-ref-email.tsx` + tests
20. `routes/booking.$jwt.tsx` + tests
21. `routes/booking._authenticated.guest-portal.tsx` (layout) + `booking.guest-portal.$bookingId.tsx`
22. `hooks/use-guest-session.ts` + tests
23. E2E CN1-CN3 + GP1-GP12 + axe matrix
24. Visual smoke 4 viewports + Read screenshots

---

## §11. Pre-done audit checklist (paste-and-fill в КАЖДОМ commit body)

Per `feedback_pre_done_audit.md`:

```
A3.{N} — pre-done audit
- [ ] Cross-tenant × every method (magic-link.service / booking-find / guest-portal — tenant A's data NEVER returned to tenant B context)
- [ ] PK separation × N dimensions (magicLinkToken: tenantId × jti; idempotency on consume)
- [ ] Enum FULL coverage (scope: 'view' | 'mutate' — обе scopes tested)
- [ ] Null-patch vs undefined-patch (consumedFromIp NULL vs missing — preserve semantic)
- [ ] UNIQUE collision per index (jti uniqueness — replay-safe)
- [ ] Adversarial negative paths:
    - [ ] Wrong-tenant secret → JWT verify reject
    - [ ] Tampered JWT signature → reject
    - [ ] Expired token → 410 Gone
    - [ ] Concurrent consume race → exactly 1 succeeds (TLI retry)
    - [ ] Cookie tampering → 401
    - [ ] Cross-tenant find via slug B → 200 OK + no email sent
    - [ ] Rate-limit exceeded → still 200 OK (silently dropped)
- [ ] Empirical curl verify endpoint live:
    - [ ] POST /booking/find → 200 OK + Mailpit catches email
    - [ ] GET /booking/jwt/:jwt/render → confirm page renders
    - [ ] POST /booking/jwt/:jwt/consume → Set-Cookie + 302
    - [ ] GET /booking/guest-portal/{id} → 200 OK with cookie
    - [ ] Second consume → 410 Gone
- [ ] Visual smoke 4 viewports + Read screenshots BEFORE «done»
- [ ] axe AA pass на all surfaces (confirmation + magic-link landing + guest portal + find form)
- [ ] Coverage floor maintained (47/53/36/47 lines/branches/funcs/statements; bump к 50/55/40/50 после M9.widget closure)
- [ ] 9-gate pipeline green: sherif / biome / depcruise / knip / typecheck / build / test:serial / smoke / e2e:smoke
- [ ] Compliance:
    - [ ] 38-ФЗ strict transactional — NO cross-sell в email body
    - [ ] ПП-1912 cancel boundary `endOfDay(checkInDate, 'Europe/Moscow')`
    - [ ] 152-ФЗ + 109-ФЗ retention disclosure в guest portal
    - [ ] iCal Cyrillic UTF-8 + ASCII filename + Europe/Moscow VTIMEZONE
- [ ] Security canon:
    - [ ] Hono >=4.12.16 EXACT pin
    - [ ] `__Host-` cookie prefix + Lax-on-set + Secure + HttpOnly
    - [ ] Two-step magic-link consume для mutate (resists Apple MPP / Slack unfurl prefetch)
    - [ ] Promise.allSettled + Math.max(0, FIXED-elapsed) padding для timing-safe
```

---

## §12. Risks / honest gaps

1. **Apple MPP / Slack unfurl prefetch DoS** — view tokens use `allowedAttempts=5` mitigation; mutate uses two-step GET-POST. Если real-world deploy показывает 5 attempts insufficient → bump к 10 or add per-IP-rate-limit на consume endpoint (carry-forward).
2. **Postbox real DKIM/sender-domain verification** — defer'ed Track B6 / M11. Until verified, M9.widget.5 demo on Mailpit; production would queue emails в Stub mode (Mock canon: same canonical interface, no domain code change).
3. **`@react-pdf/renderer` memory leak** — voucher PDF deferred M11+. M9.widget.5 ships HTML email + .ics ONLY; «Download voucher» button в guest portal → Phase 2 async-worker pattern.
4. **ial-rate-limit MemoryStore** — single-instance YC Container OK Phase 1; multi-instance (`min_instances>0` post-deploy) requires YDB-backed shared store (carry-forward).
5. **Lax-then-Strict cookie rotation complexity** — Phase 1: just Lax (works for cross-site magic-link landing). Strict-upgrade carry-forward к Phase 2 when CSRF risk profile escalates.
6. **OWASP query-string log leak `?token=`** — code-side mitigations (Cache-Control + Referrer-Policy); NGINX log scrubber = ops-side concern (carry-forward к Track B5 deploy config).
7. **63-ФЗ простая ЭП «соглашение о ПЭП»** — magic-link click = ПЭП. Текст «соглашение» в Terms — carry-forward к Track B7 (privacy + ToS landing).
8. **РКН реестр operator field** — defer M10 onboarding flow.
9. **Date modification (re-quote) в guest portal** — defer M11. Industry canon = cancel-and-rebook orchestration. M9.widget.5 ships only Cancel.
10. **Yandex Calendar deep-link** — no public URL pattern documented 2026-04-30 (R1 verified). Fallback к .ics download для Yandex Calendar users.

---

## §13. Anchor commits

- `456a591` — M9.widget.4 closure (origin/main HEAD before A3)
- `<TBD>` — M9.widget.5 pre-flight canon (this file's commit)
- `<TBD>` — A3.1 backend magic-link + .ics
- `<TBD>` — A3.2 backend email template + voucher integration
- `<TBD>` — A3.3 backend guest portal + cancel
- `<TBD>` — A3.4 frontend confirmation + guest portal
- `<TBD>` — A3 closure (done memory + ROADMAP)

---

## §14. Definition of Done M9.widget.5

- [ ] All §11 audit checklist items зелёные in КАЖДОМ commit body
- [ ] Backend magic-link service live + verified — pnpm smoke MLT1-MLT10 cross-tenant + concurrent-consume + cross-tenant + expiry
- [ ] Backend booking-find timing-safe verified — same response body + ≥800ms padding for all paths
- [ ] Backend guest-portal cookie-auth verified — `__Host-` prefix + ПП-1912 cancel boundary
- [ ] Frontend confirmation screen renders + E2E CN1-CN3 verified
- [ ] Frontend magic-link landing flow E2E GP1-GP7 verified
- [ ] Frontend guest portal E2E GP8-GP12 verified
- [ ] CDC consumer notification-dispatcher fires booking-confirmation email через email factory (Mailpit catches с .ics attachment в dev)
- [ ] axe-pass 4 themes + WCAG 2.2 AA — confirmation + magic-link landing + guest portal + find-form
- [ ] Coverage floor maintained (47/53/36/47); bump к 50/55/40/50 после M9.widget.8 closure (carry-forward)
- [ ] Plan §17 Implementation log appended (M9.widget.5 findings + new process corrections)
- [ ] `project_m9_widget_5_done.md` memory entry
- [ ] ROADMAP.md Track A row A3 `[✅]` + anchor commit hash

---

## §15. Pre-implementation freshness recheck (2026-04-30)

Per user canon «при минимальном сомнении — самый современный веб ресерч»: после plan canon commit and перед A3.1 implementation — empirical npm-registry recheck всего stack (≥2026-04-15 mandate per `feedback_research_strictness_today.md`).

**Findings (verified `npm view <pkg> version` 2026-04-30):**

| Package | Plan §5 | Actual latest | Action |
|---|---|---|---|
| `jose` | 6.2.3 | 6.2.3 (2026-04-27) | ✅ pin |
| `hono` | >=4.12.16 EXACT | 4.12.16 (2026-04-30) | ⚠️ BUMP from installed 4.12.15 |
| `ical-generator` | 10.2.0 | 10.2.0 (2026-04-17) | ✅ adopt |
| `node-ical` | 0.26.0 | 0.26.0 (2026-04-03) | ✅ devDep |
| `react-email` | ^6.0.5 | 6.0.5 (2026-04-28) | ✅ adopt |
| `@aws-sdk/client-sesv2` | 3.1040.0 | 3.1040.0 (2026-04-30) | ⚠️ BUMP from 3.1039.0 |
| `@touch4it/ical-timezones` | latest | TBD verify A3.1 | recheck before adopt |

**No breaking changes** в нашем surface. Plan §1-§14 stays unchanged.

---

## §16. Self-audit log

### Iteration 1 — R1 broad findings (4 agents 2026-04-30)
- jose 6.x migration: HS256 OK для same-issuer-and-verifier; `crypto.timingSafeEqual` internal к jose
- ical-generator 10.2.0 chosen over ics@3.12.0 (no native VTIMEZONE)
- react-email 6.0.0 (later bumped к 6.0.5 in §15 freshness recheck) unified package
- ПП РФ 1912 cancel boundary verbatim verified pravo.gov.ru
- 38-ФЗ ст. 18 (2025-10-27) transactional carve-out — no consent/unsubscribe для pure transactional
- @react-pdf/renderer memory leak persistent → defer M11

### Iteration 2 — R2 adversarial (2 agents 2026-04-30)
**Critical corrections к baseline:**
1. **Apple MPP / Slack unfurl DoS** — single-use JWT consumed by mail proxy. Mitigation: two-step GET→POST (etodd.io 2026-03-22) + `allowedAttempts=5` для view scope.
2. **Cookie scheme**: `__Host-` prefix + `SameSite=Lax-then-Strict` rotation (NOT `Domain=.sochi.app + Lax` per baseline plan §M9.widget.5).
3. **Hono GHSA April 2026** — 5 advisories (cookie + bodyLimit + jsx); pin ≥4.12.16 EXACT.
4. **Timing-safe**: Promise.allSettled + Math.max(0, FIXED-elapsed) padding (NOT fixed setTimeout).
5. **PDF off-hot-path** — defer M11+ due to persistent memory leak issues #2217 #3051.
6. **38-ФЗ cross-sell test** — «часто берут также» = реклама → strict transactional template.
7. **Rate-limit tuple key** = `(email, ref)` not IP-only (mobile NAT false-positives).
8. **ПП-1912 «до дня заезда»** = `endOfDay(checkInDate, 'Europe/Moscow')` calendar boundary (verbatim п. 16).
9. **109-ФЗ vs 152-ФЗ deletion** — retention overrides UI disclosure mandatory.
10. **Decoupled flow** — original tab polls; link opens new tab.

### Iteration 3 — R3 strict freshness (2026-04-15+)
- **Two-step magic-link**: NOT uniform industry canon; competing patterns (Stytch device-intel, Clerk same-device, BetterAuth allowedAttempts). У нас нет device-intel infra → two-step + allowedAttempts=5 для view (§D1 final).
- **`__Host-` + Strict**: drops cookie на cross-site nav. Lax-then-Strict rotation (set Lax, upgrade на next request).
- **Hono advisories verified verbatim** (GHSA-9vqf-7f2p-gf9v + GHSA-69xw-7hcm-h432 — 2026-04-30; GHSA-458j — 2026-04-15; GHSA-r5rp + GHSA-26pp — 2026-04-07). All в 4.12.16 patched.
- **TanStack Router `_authenticated`** layout-route + `beforeLoad` — current canon 1.169.0.
- **react-email 6.0.5** safe pin (5 patches in 13 days, all bug-fix tier).

### Iteration 4a — R3 strict freshness round 2 (2026-04-30, after user pushback «без полумер»)

**Triggered**: user pushback «ты уверен что действуешь без полумер?» — original R3 = 1 agent, не canonical 5. Ran 4 additional R3 agents в parallel.

**Critical corrections к baseline plan (post-canon, pre-implementation)**:

1. **`@touch4it/ical-timezones` STALE 2.5 years** (last code commit 2023-01-09; npm 1.9.0 metadata-only republish 2025-10-22). REPLACE с **`timezones-ical-library@2.2.0`** (published 2026-04-29, PR #94 by add2cal team — Add to Calendar Button ecosystem). API: `cal.timezone({ name: 'Europe/Moscow', generator: tz => tzlib_get_ical_block(tz)[0] })`.

2. **`@react-email/render` `{plainText: true}` DEPRECATED since 1.2.0 (Aug 2025)**. Canonical 2026 API = `toPlainText(component)` separate utility. `await render(<Component/>)` returns HTML; `await toPlainText(<Component/>)` returns plain text. Both required для transactional dual-render.

3. **Yandex Postbox endpoint = `postbox.cloud.yandex.net`** (NOT `postbox.yandexcloud.net` per research-cache). Region `ru-central1`. Source: `yandex.cloud/en/docs/postbox/operations/send-email` (revised 2026-02-11, no fresher).

4. **Yandex Postbox docs revision 2026-04-28** (check-domain page) — DKIM Simple = 2 CNAME / Advanced = 1 TXT. NO formal sandbox-vs-prod tier (200/24h soft default, raise via support ticket).

5. **AWS SDK `@aws-sdk/client-sesv2@3.1040.0` (2026-04-30)** — no SESv2-specific changes; `Content.Simple.Attachments` shape stable.

6. **Hono `csrf()` middleware (4.12.16 verbatim from src/middleware/csrf/index.ts)** — gates ONLY form-encoded bodies (`application/x-www-form-urlencoded|multipart/form-data|text/plain`). `application/json` requests **BYPASS csrf()** entirely. **Implication**: для JSON-only widget mutation routes — rely on SameSite=Lax cookie + CORS preflight (browsers reject simple cross-origin JSON).

7. **Hono `setSignedCookie({ prefix: 'host' })` auto-enforces** `path:'/'`, `secure:true`, `domain:undefined` (compile-time `CookieConstraint` type + runtime `generateCookie` line 87-92 in src/utils/cookie.ts patched 2026-04-07 from CVE fork). `getSignedCookie` returns `false` on tampered HMAC, `undefined` on missing, `string` on valid (constant-time via `crypto.subtle.verify`).

8. **TanStack Router `_authenticated` layout-route + `beforeLoad` redirect** verbatim from release 1.169.0 (2026-04-30). Same router instance для public + private split.

9. **Zod 4.4.1 Standard Schema direct `validateSearch`** (no `@tanstack/zod-adapter`) — TanStack Router docs commit `13d314ec` 2026-03-20.

10. **Confirmation page IA canon (R1.5)**: focus h1 + booking-ref large+tabular-nums + Radix Alert role=status email-sent banner + `<dl>` для details (NO `<p>` siblings — M9.widget.2 #12 carry-forward) + Add-to-Calendar disclosure dropdown (Google → Apple → Outlook → .ics → Yahoo; **Yandex Calendar fall-through к .ics download — no public deeplink URL exists 2026-04-30**). RU pluralization three-form ruPlural() для "взрослых". Tone «Вы / Ваш» formal canonical.

### Iteration 4 — stankoff-v2 cross-check
- Better Auth `magicLink()` plugin NOT applicable (BA ties magic-link к user account creation; widget guests ≠ user records). Custom flow.
- AWS SES v2 + Postbox pattern matches our existing factory.
- `crypto.timingSafeEqual` Buffer-byte compare canon adopt.
- TanStack Router `beforeLoad` pattern adopt с modified `requireGuestSession` semantic.
- `.ics`, PDF, voucher template — все greenfield в stankoff.

### Iteration 5 — npm empirical (2026-04-30)
- Hono installed 4.12.15 → 4.12.16 BUMP mandatory (5 GHSAs)
- @aws-sdk/client-sesv2 3.1039.0 → 3.1040.0 BUMP (2026-04-30)
- All other deps already latest

### Cumulative honest hallucinations / process gaps log: 90+ (was 80+ in baseline, +10 caught in M9.widget.5 pre-flight)

### Carry-forward к A3 implementation
- §15 freshness recheck — verify `@touch4it/ical-timezones` latest version + maintainer activity before A3.1
- Empirical Postbox curl deferred Track C3 (creds pending)
- Tenant.magicLinkSecret afterCreateOrganization hook generation pattern (extends existing organizationProfile auto-populate per `project_organization_profile_todo.md`)

---

## §17. Implementation log (carry-forward)

Каждая `pnpm test:serial` regression / `npm view` drift / live empirical evidence = new iteration entry в этом разделе.

### A3.1 (commit pending)
TBD — backend magic-link + .ics implementation findings.

### A3.2 (commit pending)
TBD — email template + voucher integration findings.

### A3.3 (commit pending)
TBD — guest portal + cancel findings.

### A3.4 (commit pending)
TBD — frontend findings.

---

**End of M9.widget.5 canonical sub-phase plan.**
