# Research: Yandex SmartCaptcha + Yandex Object Storage

**Дата:** 2026-04-27
**Источник:** research-агент волны 1
**Confidence:** SmartCaptcha High (integration/API), Medium (точные RUB цены 2026); Object Storage High (S3 surface), Medium (некоторые 2026 numeric limits)

---

## 1. Yandex SmartCaptcha 2026

### 1.1 Versions / changes

- **npm `@yandex/smart-captcha` — latest 2.9.1** (2026-02-26). Previous: 2.9.0 (2025-11-18).
- React peer range: `^16.8.0 || ^17 || ^18 || ^19` — **React 19 explicitly supported.**
- Bundles ESM (`module.mjs`) + CJS + `index.d.ts`.
- Widget script: `https://smartcaptcha.yandexcloud.net/captcha.js`.
- Validation endpoint: `https://smartcaptcha.yandexcloud.net/validate`.
- 2025-12: clients можут ship arbitrary frontend metadata алгоритму (user data, request params, fraud flags) — relevant для booking-widget (знаем org/property context).
- Сертификации 2025-01: **152-ФЗ, ГОСТ Р 57580, PCI DSS** confirmed — useful для нашей compliance story.

### 1.2 Frontend integration (React 19 + TanStack Router)

`@yandex/smart-captcha` 2.9.1. Два компонента:

- `<SmartCaptcha>` — visible "I am not a robot".
- `<InvisibleSmartCaptcha>` — challenge popup только когда ML flags request.

**Props:** `sitekey`, `visible`, `language` (`ru|en|be|kk|tt|uk|uz|tr`), `test`, `webview`, `shieldPosition`, `hideShield`.

**Events:** `onSuccess(token)`, `onTokenExpired`, `onChallengeVisible`, `onChallengeHidden`, `onNetworkError`, `onJavascriptError`.

**Reset pattern:** `key={resetKey}` с incrementing state — token single-use, re-arming требует remount.

Для TanStack Router: mount widget в route component (no router-specific glue). Widget injects hidden `<input name="smart-token">` для non-React fallback; в React читаем token через `onSuccess`.

### 1.3 Backend verify

- **POST** `https://smartcaptcha.yandexcloud.net/validate` (`Content-Type: application/x-www-form-urlencoded`).
- Params: `secret` (server key, **не** client sitekey), `token` (from `onSuccess`), `ip` (end-user IP — required for accurate scoring).
- Response 200: `{ "status": "ok"|"failed", "message": string, "host": string }`. `host` only on `ok`.
- **Token TTL: 5 минут**, single-use.
- ⚠️ **Doc explicitly:** treat **non-200 как "ok"** to avoid degrading UX during Yandex outages — quirk vs reCAPTCHA.

### 1.4 Invisible vs interactive — рекомендация для booking-widget

**Invisible.** Booking-widget conversion fragile; forced "I am not a robot" tick на каждом search увеличивает drop-off. Invisible показывает popup challenge только когда ML flags request.

**Trade-off:** invisible mode требует более thoughtful frontend wiring (`visible` state + `execute()` on submit) и ongoing-traffic check через `onChallengeHidden` для reset state когда user dismisses без completing.

### 1.5 Layered defence (captcha не достаточно)

Captcha alone insufficient. Layered defence:

1. **Rate-limit per IP+org+endpoint** at backend (Hono middleware) — блокирует volumetric abuse до captcha quota.
2. **Captcha** на booking-creation, review-submission, password-reset — verifies "human-likeness".
3. **Origin allow-list** на captcha sitekey (Yandex console: pin to `*.<our-domain>.ru`) — defeats sitekey theft.
4. **WAF** (Smart Web Security) — DDoS layer, separate service.

Token forgeable только если attacker steals server key — `SMARTCAPTCHA_SERVER_KEY` в YC Lockbox, rotate quarterly.

### 1.6 Billing 2026

- **Restricted mode = free.** Activates автоматически когда billing account не `ACTIVE`/`TRIAL_ACTIVE`. В restricted mode все `/validate` returns `ok` и widget показывает "SmartCaptcha is restricted" notice.
- **Paid mode:** charged только за `/validate` calls returning `ok` AND unique token issued ≤10 min ago AND с valid secret+token. Failed requests, expired tokens, retries — **не billed**.
- Public price (2026-Q1): **from $0.80 / 1 000 valid requests** (RUB equivalent, VAT). For 10 000 booking-widget submissions/month tenant → sub-cent territory.

### 1.7 Errors + timings

- `Token invalid or expired.` → user retry path; reset widget `key`.
- `Authentication failed. Secret has not provided.` → backend bug.
- `failed` с empty message → bot detected; show "Verification failed, please try again".
- `onNetworkError` → frontend; treat as soft-fail (allow submission with rate-limit fallback).
- Latency: typical `/validate` under 100 ms из России; SLA не публикован.

### 1.8 Где placement в booking widget

Three friction points в funnel:

1. **Search form (date/guests) — DO NOT add captcha.** Search anonymous high-volume, user не committed.
2. **Booking submission (after rate selection, before payment) — YES, invisible.** Bots try scrape inventory или commit fake reservations.
3. **Reviews / contact-form — YES, visible.** Lower-volume, asynchronous; tolerance higher.

**Conversion drop** от visible captcha 3-10% в hospitality. Invisible cuts to near-zero unless flagged.

**Competitor patterns:** Bnovo / TravelLine widgets — captcha только на final submission. Booking.com / Ostrovok — risk-engine + interactive captcha только на suspicious sessions.

---

## 2. Yandex Object Storage 2026

### 2.1 S3 SDK compatibility

- **AWS S3 v4 (AWS4-HMAC-SHA256) signature** compatible.
- `@aws-sdk/client-s3 ^3.1035.0` — **works.** Project canon уже использует.
- Config: `region: 'ru-central1'`, `endpoint: 'https://storage.yandexcloud.net'`, `forcePathStyle: false` (virtual-hosted style).

**Caveats vs raw AWS S3:**
- ⚠️ **No SSE-C** (customer-provided keys) — только `aws:kms` SSE supported. Любой код с `x-amz-server-side-encryption-customer-*` headers fail.
- No S3 Object Lambda, no S3 Select-on-Glacier, no Replication-time-control, no Bucket Notifications via SNS (use Yandex Audit Trails / Cloud Logging).
- Lifecycle supported, но **cron runs once daily at 00:00 UTC** — propagation can take hours.

### 2.2 Lifecycle policies — TTL fit для passport photos

Supported actions:
1. **Expiration / deletion** (objects + non-current versions).
2. **Storage-class transition** (Standard → Cold → Ice).
3. **AbortIncompleteMultipartUpload**.

**Filters:** Prefix, object-size min/max, object **tags** (только via API/Terraform), combinable с `And`. **One filter per rule**, multiple rules per bucket.

**Practical pattern для passport photos:**

```xml
<Rule>
  <ID>passport-photos-ttl-180d</ID>
  <Filter><Prefix>passport-photos/</Prefix></Filter>
  <Status>Enabled</Status>
  <Expiration><Days>180</Days></Expiration>
</Rule>
<Rule>
  <ID>cleanup-stuck-multipart-7d</ID>
  <AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload>
</Rule>
```

⚠️ **Caveat** — daily-batch lifecycle gives ±1 day jitter. Для строгого 152-ФЗ retention proof, complement с **scheduled worker** который issues `DeleteObject` on cron, лифecycle — safety net.

### 2.3 Server-side encryption

- **SSE-KMS only** (`aws:kms`) — backed by Yandex KMS symmetric key (`AES_128` или `AES_256`, configurable rotation_period).
- KMS key должен быть в **same folder** что и bucket.
- SA roles: `kms.keys.encrypter` (PUT), `kms.keys.decrypter` (GET), или `kms.keys.encrypterDecrypter`.
- ⚠️ **No SSE-C, no SSE-S3** (AES256 с Yandex-managed keys). Header `x-amz-server-side-encryption: AES256` silently ignored или rejected.
- Default-encryption per-bucket (`PutBucketEncryption`); applies to **new objects only** — pre-existing objects remain unencrypted unless re-uploaded.
- Envelope encryption: **deleting KMS key destroys data** — guard key-delete на IAM (deny `kms.keys.delete` для всех кроме sealed admin).
- Для 152-ФЗ biometrics: SSE-KMS с rotation_period ≤ 12 months satisfies "encryption at rest"; combine с bucket-level access policy + audit log.

### 2.4 Pre-signed URLs

- AWS Sig V4 (`AWS4-HMAC-SHA256`); built directly via `@aws-sdk/s3-request-presigner`.
- **Max TTL: 2 592 000 sec = 30 days.** Для passport-photo operator-audit views — TTL **5–15 minutes**.
- Methods: GET, PUT, HEAD, DELETE.
- URL: `https://<bucket>.storage.yandexcloud.net/<key>?X-Amz-...`
- Pre-signed POST forms — также supported.

### 2.5 Multipart, versioning, regions

- **Multipart:** recommended для objects ≥100 MB. Min part size 5 MB, max ~5 GB per part, max 10 000 parts → ~5 TB object. Для passport JPEGs (~2-5 MB) не используем.
- **Versioning:** `Enabled`/`Suspended`/null. Каждая версия billed separately. **Recommendation для passport bucket:** versioning **off** — overwrites на sensitive PII bucket should be loud, не silent history.
- **Region:** `ru-central1` — один logical region; AZ suffixes `ru-central1-a/b/c` exist но Object Storage abstracts AZs internally.

### 2.6 Billing 2026

⚠️ **Starting 2026-05-01 a price increase announced** (covered by `_includes/pricing-increase-2026-05.md` в docs repo) — точные figures re-check на provision day.

Structure (стабильная, RUB, indicative values 2026-Q1):
- **Standard:** ~1.96 ₽/GB-month после first GB.
- **Cold:** ~0.86 ₽/GB-month, retrieval surcharge.
- **Ice:** ~0.54 ₽/GB-month, **min billable 12 months** — early delete = full 12-month charge.
- Operations: Class A (PUT/COPY/POST/LIST) ~50 ₽/100 000; Class B (GET/HEAD) ~5 ₽/100 000.
- Egress: free intra-cloud; ~1.50 ₽/GB to internet.
- Free tier: 1 GB storage + small ops allowance per month.
- Since 2026-04-20: **S3 Inventory billable** — disable unless needed.

### 2.7 Quotas

- Object key ≤ 1024 bytes (UTF-8).
- PUT request header total ≤ 8 KB; user-defined metadata ≤ 2 KB.
- Buckets per cloud — soft quota (~25, requestable).
- Per-bucket request rate — не публикован; passport workflow (≪100 req/s) не hits.

### 2.8 MinIO как локальный mock — parity gaps

- **Lifecycle:** MinIO runs lifecycle scans more frequently than Yandex's 00:00 UTC. Test «object gone after 1 day» passes locally, fails в prod within day. Tests should mock-clock lifecycle.
- **SSE:** MinIO supports SSE-S3 + SSE-KMS (через Vault) + SSE-C. **Yandex supports only SSE-KMS.** Code path с SSE-C должен быть explicitly forbidden — wrapper всегда passes `ServerSideEncryption: 'aws:kms'`.
- **Bucket policy:** MinIO supports broader IAM JSON; keep policies minimal, S3-canonical.
- **Versioning, Pre-signed URLs:** parity OK.

---

## 3. SmartCaptcha + booking-widget UX

### 3.1 Где placement

См. 1.8.

### 3.2 Реализация

```tsx
// На booking submission step
import { InvisibleSmartCaptcha } from '@yandex/smart-captcha'

const captchaRef = useRef<{execute: () => Promise<string>}>()

async function handleBookingSubmit(formData) {
  const token = await captchaRef.current.execute()
  const result = await fetch('/api/public/booking-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...formData, captchaToken: token })
  })
  if (result.status === 401) {
    // captcha failed на бэке — reset и retry
    setCaptchaResetKey(k => k + 1)
  }
}

return <InvisibleSmartCaptcha
  ref={captchaRef}
  sitekey={import.meta.env.VITE_SMARTCAPTCHA_SITEKEY}
  language="ru"
  key={captchaResetKey}
/>
```

```ts
// Backend: middleware verify
async function verifyCaptcha(token: string, ip: string) {
  const params = new URLSearchParams({
    secret: env.SMARTCAPTCHA_SERVER_KEY,
    token,
    ip,
  })
  const res = await fetch('https://smartcaptcha.yandexcloud.net/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  // ⚠️ Yandex рекомендует treat non-200 as ok
  if (!res.ok) {
    log.warn('SmartCaptcha unavailable, allowing through', { status: res.status })
    return true
  }
  const data = await res.json()
  return data.status === 'ok'
}
```

---

## 4. Object Storage + passport-photo workflow

### 4.1 End-to-end flow

1. Guest at check-in shows passport → operator (или guest's phone) takes photo.
2. Frontend uploads via **pre-signed PUT URL** (не via backend pass-through — saves bandwidth + не loading PII в наш app process).
3. Backend issues pre-signed URL key = `passport-photos/{orgId}/{guestId}/{uuid}.jpg`, `Content-Type: image/jpeg`, TTL 5 min.
4. After upload, backend hits Yandex Vision OCR API на новый key; OCR returns parsed fields → draft Guest entity; operator confirms.
5. После OCR success + operator-confirm, backend may immediately issue server-side `DeleteObject` (если regulation permits) OR rely on lifecycle rule.

### 4.2 Encryption-at-rest для biometrics

- Bucket-level `PutBucketEncryption` с KMS key dedicated for PII (separate KMS key from non-PII buckets — blast-radius isolation).
- KMS key rotation every 12 months.
- IAM: только `passport-ocr-svc` SA имеет `kms.keys.encrypterDecrypter`; operators access decrypted images только via short-TTL pre-signed URLs (audit-logged).

### 4.3 Pre-signed URL для operator audit

- TTL **5–15 min**, GET only, single-use enforced через issuing fresh URL per audit-view click + recording in our `activity` outbox.
- Никогда не embed URL в email или persist в DB beyond audit log.

### 4.4 Retention / TTL policy

Two competing pressures:
- **152-ФЗ:** process PII только as long as needed. После check-in completes (или регистрация в МВД/ЕПГУ confirmed), фото больше не нужно.
- **Compliance audit / dispute window:** keep evidence до 1 year.

**Recommended layered TTL:**
- **Bucket lifecycle rule:** delete after 180 days (safety net).
- **Workflow worker:** explicitly delete photo within 24h успешного МВД/ЕПГУ acknowledgement OR 24h booking cancellation (whichever sooner).
- **Cancellation policy:** если booking cancelled до check-in, delete immediately — purpose dissolved.
- **Hash retain:** keep SHA-256 of photo + OCR result (без PII) для 1 year for fraud-detection — не biometric storage.

### 4.5 Backup

Для PII bucket: **не enable cross-region backup.** 152-ФЗ + data-residency means everything stays в `ru-central1`. Reliance на YC's internal triple-replication. Versioning **off**.

---

## 5. Альтернативы (rejection rationale)

- **Cloudflare Turnstile / hCaptcha / reCAPTCHA** — superior in some ways, но violate "Yandex Cloud only" + foreign-data-flow concerns под 152-ФЗ. **Rejected.**
- **AWS S3 / Selectel / VK Cloud Object Storage** — AWS unavailable RU; Selectel/VK technically usable но violate canon. Yandex имеет lowest egress to RU-edge users + tightest integration с Vision/KMS/Lockbox. **Rejected.**
- **Self-hosted MinIO в prod** — would mean we own erasure-coding, replication, ops. **Rejected.** MinIO остаётся **local-dev mock only.**

---

## 6. Открытые вопросы

1. Точная **2026-05-01 storage price increase** — re-check на provision day.
2. SmartCaptcha rate limit на `/validate` — не задокументирован.
3. Lifecycle exact propagation SLA — docs say "daily 00:00 UTC, takes a few hours". Empirical test нужен.
4. Per-bucket request-rate ceilings — не задокументированы.
5. `@yandex/smart-captcha` 2.9.1 React-19-strict-mode safe — peer range says yes, но smoke test нужен (double-mount в StrictMode common breakage point).
6. МВД/ЕПГУ retention requirement — 180-day lifecycle rule placeholder; final зависит от того, что МВД API требует re-show.

---

## 7. Источники (URL + дата 27.04.2026)

**SmartCaptcha:**
- [Concepts/react](https://yandex.cloud/en/docs/smartcaptcha/concepts/react)
- [Concepts/invisible-captcha](https://yandex.cloud/en/docs/smartcaptcha/concepts/invisible-captcha)
- [Concepts/validation](https://yandex.cloud/en/docs/smartcaptcha/concepts/validation)
- [Quickstart](https://yandex.cloud/en/docs/smartcaptcha/quickstart)
- [Restricted-mode](https://yandex.cloud/en/docs/smartcaptcha/concepts/restricted-mode)
- [Pricing](https://yandex.cloud/en/docs/smartcaptcha/pricing)
- [Validate-captcha operations](https://yandex.cloud/en/docs/smartcaptcha/operations/validate-captcha)
- [@yandex/smart-captcha (npm)](https://www.npmjs.com/package/@yandex/smart-captcha)
- [GitHub source](https://github.com/yandex-cloud/docs/tree/master/ru/smartcaptcha)

**Object Storage:**
- [Concepts/lifecycles](https://yandex.cloud/en/docs/storage/concepts/lifecycles)
- [Concepts/encryption](https://yandex.cloud/en/docs/storage/concepts/encryption)
- [Concepts/pre-signed-urls](https://yandex.cloud/en/docs/storage/concepts/pre-signed-urls)
- [Concepts/versioning](https://yandex.cloud/en/docs/storage/concepts/versioning)
- [Concepts/multipart](https://yandex.cloud/en/docs/storage/concepts/multipart)
- [Concepts/limits](https://yandex.cloud/en/docs/storage/concepts/limits)
- [Pricing](https://yandex.cloud/en/docs/storage/pricing)
- [PutBucketEncryption API](https://yandex.cloud/en/docs/storage/s3/api-ref/bucket/putbucketencryption)
- [Pricing increase 2026-05](https://raw.githubusercontent.com/yandex-cloud/docs/master/ru/_includes/pricing-increase-2026-05.md)

**MinIO compatibility:**
- [Object Lifecycle Management](https://docs.min.io/enterprise/aistor-object-store/administration/object-lifecycle-management/)
- [SSE-KMS](https://min.io/docs/minio/linux/administration/server-side-encryption/server-side-encryption-sse-kms.html)
