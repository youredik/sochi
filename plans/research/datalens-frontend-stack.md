# Research: DataLens connection patterns + Frontend stack 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 3
**Confidence:** High (DataLens YDB connection, Recharts, react-webcam, photo upload, 152-ФЗ camera consent), Medium (точные DataLens pricing, JWT embed schema)

---

## 0. Главные находки

1. **DataLens YDB direct supported** (через host+port+database+auth).
2. **Multi-tenant SaaS canonical pattern** — один shared workbook + RLS через signed JWT с `org_id`. НЕ per-tenant workspace.
3. **Phase 1**: Native KPI domain (наш UI). **Phase 2**: DataLens embedded (after deploy).
4. **Recharts v3 через shadcn `Chart`** — winner, single dependency.
5. **Tremor куплен Vercel** (2025-01-22) — дублирует shadcn, отметаем.
6. **Yandex Cloud НЕ имеет** managed image-transformation (Cloudinary-like). Pipeline = Object Storage + Cloud Functions + sharp.
7. **OCR server-side** (Yandex Vision passport), НЕ browser. Capture client-side через jscanify.

---

## 1. Yandex DataLens connection patterns

### 1.1 DataLens 2026 capabilities

**Поддерживаемые источники** (last-updated 2026-01-14):

Базы данных: ClickHouse, **YDB**, PostgreSQL, MySQL, YTsaurus CHYT, Greenplum, MS SQL Server, Oracle, Trino, Prometheus, Snowflake.
Файлы и сервисы: Files, Yandex Documents, Google Sheets, Yandex Query, Metrica, AppMetrica, Yandex Cloud Billing, Yandex Monitoring, **DataLens Usage Analytics**, SpeechSense, API Connector.
Партнёрские: 1C Extractor, Bitrix24.

**YDB direct: supported.** Host + port (default 2135) + database path + auth (username/password или OAuth-token, либо service account через YC IAM). VIEW-объекты YDB также поддерживаются как источник.

**Авторизация в DataLens к YDB:** OAuth-token / service-account static key / Yandex passport.

### 1.2 Multi-tenant SaaS connection patterns

Канон:
- **Public DataLens** (`datalens.yandex.cloud/public`) — без авторизации, для маркетинговых dashboard, **не для tenant-данных**.
- **Private embed (Business tariff)** — JWT (PS256) per-dashboard embed-key, max 10 час token TTL. URL: `https://datalens.ru/embeds/dash#dl_embed_token=<jwt>`. Параметры делятся на **signed** (внутри JWT-payload, immutable) и **unsigned** (URL query). `postMessage` поддерживается для динамической ротации токена.
- **DataLens API** — позволяет создавать workbook'и и connections programmatically через service account с ролью `datalens.creator`.

**Row-Level Security (RLS) в DataLens**: настраивается на уровне dataset либо source. Поддерживается переменная `userid:userid`, но это **внутренний DataLens user ID**, не внешний embed-subject. Для SaaS-сценария «один dataset на всех tenant'ов» канон 2026 — **переносить RLS на сторону источника** (фильтр в YDB по orgId), либо использовать signed embed-параметр `org_id` в JWT.

**Каноничный SaaS-паттерн (recommendation)**:
1. Один shared workbook на все tenants.
2. Один dataset на YDB-view (`v_kpi_*`), агрегирующую все tenants с колонкой `org_id`.
3. Embed-key + JWT с signed-параметром `org_id`.
4. В dataset-фильтре: `[org_id] = [Params.org_id]`.
5. Backend (Hono) выпускает JWT при загрузке `/dashboard` страницы.

### 1.3 Data preparation на нашей стороне

YDB — OLTP, не OLAP. Прямые запросы DataLens к raw-таблицам `bookings/folio_*` будут летать на маленьких объёмах (десятки отелей, тысячи бронирований/день), но не масштабируются.

**Канон**:
- **Materialized rollup-таблицы** в YDB:
  - `kpi_occupancy_daily(org_id, property_id, date, room_count, occupied_count, occupancy_pct)`
  - `kpi_revenue_daily(org_id, property_id, date, room_revenue, adr, revpar)`
  - `kpi_booking_funnel_daily`.
- **Refresh через CDC-outbox + worker**, не streaming. Cron каждый час делает full reconciliation за last-7-days как safety-net.
- **DataLens читает rollup напрямую**, агрегации не на flight.
- **Real-time не нужен** для KPI — natural-cadence «сутки».

### 1.4 Embedded dashboards

- **iframe** — основной канал. `<iframe src="https://datalens.ru/embeds/dash#dl_embed_token=...">`.
- **Token rotation** через `window.postMessage({type: 'datalens-token-update', token: newJwt})` без перезагрузки iframe.
- **Mobile responsive** — DataLens dashboards имеют viewport-адаптацию, но детальный контроль ограничен. Для mobile-first HoReCa лучше **native KPI summary** в нашем app + «Open full dashboard» link на DataLens на desktop.
- **White-label / custom branding** — крайне ограничено в managed DataLens. Self-host (DataLens OSS, Apache 2.0) даёт полный CSS-control.

### 1.5 Cost economics 2026

Биллинг **по seats** (DataLens-пользователи), не per-query:
- **Free**: один individual user, 30 дней trial team-collab.
- **Standard**: per-seat × количество seats.
- Hard cap **2 000 queries / seat / month** для private embed.

**Прикидка для Сочи small hotel**: owner + 1-2 manager seats = 3 seats. ~1500-3000 ₽/мес на DataLens.

### 1.6 Альтернативы

- **Apache Superset** — open-source, self-host. Dev-friendly, но требует ops.
- **Metabase** — open-source, JWT-embed canonical, русский UI частичный.
- **DataLens OSS** — Apache 2.0 на GitHub `datalens-tech/datalens`. Plus: white-label, no per-seat billing. Minus: ops overhead. **Private embed (JWT) — НЕ в OSS**.
- **Tableau / PowerBI** — non-RU, отметаем.

### 1.7 Решение для HoReCa SaaS (decision)

**Phase 1 (current):** Native KPI domain. Расчёт в YDB rollup-tables. Frontend renders 3 charts через **shadcn + Recharts**. **DataLens не интегрирован.**

**Phase 2 (after deploy):** Embedded **DataLens managed Business** через JWT. Native KPI остаётся, DataLens — full self-service ad-hoc.

**Phase 3 (если customer-scale делает per-seat нерентабельным):** Миграция на **DataLens OSS self-host** в managed-k8s YC, либо Superset. Trigger: > 100 paying tenants × > 3 seats × > 500 ₽/seat ≈ 150k ₽/мес OPEX.

---

## 2. Charting library 2026

### 2.1 Сравнение

| Library | Bundle (gzip) | React 19 | a11y | shadcn fit | Verdict |
|---|---|---|---|---|---|
| **Recharts v3.x** | ~94 KB | yes | `accessibilityLayer` default true в v3, SVG ARIA | **Native (shadcn `Chart` использует Recharts)** | **WINNER** |
| visx | ~15 KB per-package | yes | manual | требует кастомных wrappers | для bespoke |
| Apache ECharts | ~250+ KB | через wrapper | weak (canvas) | плохо | overkill |
| Chart.js | ~120 KB | yes | weak (canvas) | не нативно | legacy |
| Tremor | ~150 KB | yes (Vercel-acquired 2025) | хорошо | overlap с shadcn | дублирует |
| Nivo | per-chart 50-100 KB | yes | хорошо | конфликтует с shadcn tokens | избыточно |

### 2.2 Best practice 2026

Companies shipping internal analytics dashboards **универсально выбирают Recharts** в 2026.

Recharts v3 включает:
- `accessibilityLayer` по умолчанию (keyboard-controls + ARIA).
- SVG output совместим с `aria-label`/`role`/`tabIndex` — критично для axe gate.

**shadcn `Chart` component (v4) использует Recharts v3** под капотом. Закрывает design-token integration (CSS-vars наследуются), TypeScript, и a11y одной зависимостью.

### 2.3 Recommendation

**Recharts v3 через shadcn `Chart`.**

Concrete plan для KPI dashboard:
- Occupancy → `<LineChart>` с y-domain [0, 100], custom tick formatter `${v}%` (через `format-ru.ts`).
- ADR → `<BarChart>` с currency tick formatter.
- RevPAR → `<LineChart>` + reference line MTD-average.

Bundle delta: ~95 KB gzip, оплачено единожды. Lazy-loaded только на route `/dashboard`.

---

## 3. WebRTC + camera capture для passport scanner

### 3.1 Browser support 2026

- `navigator.mediaDevices.getUserMedia` — universal на iOS 14.3+, Android Chrome, desktop.
- **HTTPS обязателен** в prod. Localhost — exception.
- **iOS Safari quirks:**
  - Без `playsinline` на `<video>` — fullscreen launch вместо inline. **Always set `playsInline={true}`**.
  - Камера re-prompts permissions при route-navigation. Mitigation: keep camera-mounting под одним route.
- **Permission denied** — graceful fallback на file upload.

### 3.2 UX patterns

Pattern stack:
1. **Live capture viewport** (react-webcam + `videoConstraints: { facingMode: 'environment', width: 1920, height: 1080 }`).
2. **File upload fallback** (`<input type="file" accept="image/*" capture="environment">`).
3. **Document edge detection client-side** через **jscanify** (built on OpenCV.js, supports React 19).
4. **EXIF auto-rotate** через `exifr`.
5. **Lighting indicator** — sample brightness Canvas pixel-data.
6. **Stability detection** — 1-second motion-free buffer.

### 3.3 Libraries

- **react-webcam** — canonical wrapper.
- **jscanify** — document detection + perspective correction.
- **MRZ extraction** — отдельный шаг на сервере (не browser).
- **Smart ID Engine** (Smart Engines) — RU vendor, WASM SDK для PWA. Commercial.

**Recommendation:** react-webcam + jscanify (client-side capture & crop) → upload JPEG → **Yandex Vision OCR (passport model) server-side**. Не делаем browser-OCR — server-side имеет лучшую модель + обработка PII в одной trusted-zone.

### 3.4 Privacy considerations

- **152-ФЗ (поправки 156-ФЗ от 2025-06-24, в силе с 2025-09-01):** перед `getUserMedia()` — modal с явным checkbox «Согласие на обработку ПДн» с текстом, ссылкой на политику, FIO/паспорт оператора. **Без согласия камера не запускается.**
- Video stream **не сохраняется локально**. Только итоговый JPEG.
- Compressed JPEG quality ≤85, max 1920×1080.
- Server-side: image hold ≤24h, OCR'нутые text-fields живут дольше; raw JPEG удаляется по cron.

### 3.5 HEIC handling (iPhone)

- Browser native HEIC: только Safari. Chrome/Firefox — нет.
- **Client-side: `heic2any`** (libheif WASM, 2.7 MB). + Web Worker — не блокирует main thread.
- **Server-side fallback:** sharp + libheif на бекенде. Frontend пытается heic2any → если падает, отправляет HEIC raw, backend конвертит.
- 2.7 MB lib — **lazy-loaded** только когда detected `image/heic` MIME.

---

## 4. Photo upload patterns 2026

### 4.1 Direct browser → Yandex Object Storage

**Canonical pattern:**
1. Frontend → backend `POST /api/uploads/presign` с `{ contentType, size, kind }`.
2. Backend (Hono) генерит pre-signed PUT URL через AWS Signature V4. TTL ≤ 1 час.
3. Frontend → S3 PUT с file blob + tracked progress.
4. Frontend → backend `POST /api/uploads/finalize` с object key для записи в `media_objects` таблицу.

Avoids backend bandwidth.

### 4.2 Multipart upload

- Threshold: > 100 MB по реко Yandex.
- Property-photos (2-5 MB после compression) — **не нужен**.
- Для panorama/video — да.

### 4.3 Compression pre-upload

- **`browser-image-compression`** — 4MP iPhone (4 MB) → ~500 KB при quality 85.
- Конфигурация: `maxSizeMB: 0.8, maxWidthOrHeight: 1920, useWebWorker: true, fileType: 'image/jpeg'`.
- Применяем **до** crop.

### 4.4 Crop / rotate

- **`react-easy-crop`** — canonical lib.
- Property photos: **16:9** (consistent с TravelLine/Bnovo). Optional 4:3.
- Avatar: 1:1.
- Rotate buttons (90° steps) + free-rotate slider.

### 4.5 Validation

Client-side (UX):
- File type: `image/jpeg, image/png, image/webp, image/heic, image/heif`.
- Size: max 20 MB до compression, 1 MB после.
- Dimensions: min 800×600, max 8192×8192.

Server-side (security):
- **MIME sniffing** (read magic-numbers, не trust client header) — `file-type` lib.
- **EXIF strip** для PII/GPS-tags.
- **Size re-check** в Object-Storage post-PUT.

### 4.6 Progress UX

- Upload progress per file через `XMLHttpRequest.upload.onprogress`.
- Concurrent **max 3** files.
- **Pause/resume** только для multipart.
- Skeleton + `<Progress>` shadcn + sonner toast.

---

## 5. Прочие frontend patterns 2026

### 5.1 Mobile-first

- iPhone 14+ baseline (Safari 17+), Galaxy A-series (Chrome Android 130+).
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- `touch-action: manipulation`.
- shadcn `Drawer` (vaul) для mobile, `Sheet` для desktop.

### 5.2 Form validation

- **TanStack Form 1.29** (наш choice) + Zod 4 adapter.
- HTML5 native fallback.
- ARIA: `aria-invalid="true"` + `aria-describedby="field-error"`.

### 5.3 Loading states

- Skeleton screens > spinners.
- Optimistic UI через TanStack Query.
- Suspense + `<ErrorBoundary>` per-route.

### 5.4 Error boundaries

- React 19 `ErrorBoundary` через TanStack Router `errorComponent`.
- Error reporting → **Yandex Monium**.

### 5.5 i18n

- **Lingui v6**. ICU MessageFormat.
- Date: `Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' })`.
- Currency: `Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })`.

### 5.6 Performance

- **React Compiler** GA — auto-memoization.
- TanStack Router lazy routes + auto code-split.
- `loading="lazy"` на `<img>`, `decoding="async"`.
- TanStack Virtual для лонг-листов (> 100 rows). React 19 `useFlushSync: false`.

### 5.7 a11y

- **WCAG 2.2 AA** через axe-core 4.11.3.
- Radix primitives keyboard-nav из коробки.
- Booking grid: APG canonical + `aria-colspan`.
- Charts: Recharts v3 `accessibilityLayer` default true.

---

## 6. Сводка решений

| Вопрос | Решение | Когда |
|---|---|---|
| KPI dashboard primary | Native shadcn+Recharts | Phase 1 (now) |
| DataLens role | Embedded private (JWT PS256) для self-service | Phase 2 (post-deploy) |
| KPI data prep | Materialized rollup-tables в YDB, CDC-driven worker + hourly cron | Phase 1 |
| Charting library | **Recharts v3** через shadcn `Chart` | Phase 1 |
| Camera capture | **react-webcam + jscanify** + `playsInline` + 152-ФЗ consent gate | Function 1.2 |
| OCR | **Yandex Vision OCR (passport model) server-side** | Function 1.2 |
| HEIC | **heic2any client** + sharp/libheif server fallback | Property photos |
| Image compression | **browser-image-compression** quality 85 | Property photos |
| Image crop | **react-easy-crop** 16:9 | Property photos |
| Upload pattern | Pre-signed PUT direct → Object Storage | Property photos |
| RLS DataLens | Signed JWT param `org_id` + dataset filter | Phase 2 |
| Multi-tenant DataLens | Один shared workbook + RLS, **не** per-tenant workspace | Phase 2 |

---

## 7. Открытые вопросы

1. **DataLens private embed JWT API** — точная schema (`embedId`, `iat`, `exp`, `dlEmbedService`, `params`) — нужен first-call POC при наличии Business-tariff аккаунта.
2. **Per-seat cost** для DataLens Business 2026 — точная ставка скрыта captcha. Из YC console при logged-in account.
3. **Recharts v3 axe-pass** — добавить smoke-test в pre-push.
4. **iOS Safari getUserMedia repeated permission prompts** — empirical-test обязателен на физическом iPhone.
5. **Yandex Vision OCR passport model** — sample-call для verifying response shape.
6. **DataLens OSS self-host** — оценка YC managed-k8s OPEX vs Standard tariff break-even. Триггер ~ 100 tenants.

---

## 8. Источники

- DataLens connections: [yandex.cloud/docs/datalens/concepts/connection](https://yandex.cloud/en/docs/datalens/concepts/connection/)
- DataLens YDB: [ydb.tech/docs/integrations/visualization/datalens](https://ydb.tech/docs/en/integrations/visualization/datalens)
- DataLens embed: [yandex.cloud/docs/datalens/dashboard/embedded-objects](https://yandex.cloud/en/docs/datalens/dashboard/embedded-objects)
- DataLens RLS: [github.com/yandex-cloud/docs/.../row-level-security.md](https://github.com/yandex-cloud/docs/blob/master/en/datalens/security/row-level-security.md)
- DataLens OSS: [github.com/datalens-tech/datalens](https://github.com/datalens-tech/datalens)
- Recharts v3 migration: [github.com/recharts/recharts/wiki/3.0-migration-guide](https://github.com/recharts/recharts/wiki/3.0-migration-guide)
- shadcn Chart: [ui.shadcn.com/docs/components/radix/chart](https://ui.shadcn.com/docs/components/radix/chart)
- React charting comparison 2026: [pkgpulse.com/blog/recharts-vs-chartjs-vs-nivo-vs-visx-react-charting-2026](https://www.pkgpulse.com/blog/recharts-vs-chartjs-vs-nivo-vs-visx-react-charting-2026)
- Tremor → Vercel: [vercel.com/blog/vercel-acquires-tremor](https://vercel.com/blog/vercel-acquires-tremor)
- react-webcam: [npmjs.com/package/react-webcam](https://www.npmjs.com/package/react-webcam)
- jscanify: [github.com/puffinsoft/jscanify](https://github.com/puffinsoft/jscanify)
- getUserMedia 2026 guide: [blog.addpipe.com/getusermedia-getting-started](https://blog.addpipe.com/getusermedia-getting-started/)
- Yandex Object Storage pre-signed: [yandex.cloud/docs/storage/concepts/pre-signed-urls](https://yandex.cloud/en/docs/storage/concepts/pre-signed-urls)
- heic2any: [github.com/alexcorvi/heic2any](https://github.com/alexcorvi/heic2any)
- 152-ФЗ amendments 2025-09-01: [garant.ru/article/1862510](https://www.garant.ru/article/1862510/)
