# Empirical credentials setup — Vision / ЮKassa / Postbox

> **Last updated 2026-04-29** (Track 1 of empirical-batch closed; Track 2 ждёт credentials).

Перед запуском empirical curl скриптов нужно получить credentials для трёх external API, чтобы заверить behaviour-faithful contract наших Mock/Stub адаптеров.

**Все три ставятся бесплатно**:
- Yandex Vision OCR sandbox = бесплатно (free quota + sandbox endpoint)
- ЮKassa Test mode = бесплатно (separate test shop, no real money)
- Yandex Cloud Postbox sandbox = бесплатно (10 000 emails/month free tier)

Юридическая часть (ИП/ООО, 152-ФЗ РКН-регистрация, ОФД, КЭП) — **отдельная фаза**, эти creds нужны параллельно или после.

---

## 1. Yandex Cloud Vision OCR — `verify-vision-empirical.ts`

### Что нужно
```dotenv
YC_API_KEY=AQVN...        # API key с scope yc.ai.vision.execute
YC_FOLDER_ID=b1g...       # ID папки YC
```

### Шаги

1. **Создать Yandex Cloud аккаунт** (если ещё нет): https://console.yandex.cloud/
2. **Создать каталог (folder)** в YC console если не существует — обычно есть `default`. Скопировать `Folder ID` из URL: `console.yandex.cloud/folders/<FOLDER_ID>`. Это `b1g...`.
3. **Создать сервисный аккаунт** (Service Account):
   - Console → IAM → Service Accounts → Create
   - Name: `vision-empirical-verify`
   - Roles: `ai.vision.user` (минимально-необходимое)
4. **Создать API key для SA**:
   - SA → "Create API key"
   - Scope: `yc.ai.vision.execute` (только Vision; не `yc.ai.foundationModels.execute` — wider scope не нужен)
   - Скопировать ключ (только при создании!) → `YC_API_KEY`
5. **Запуск**:
   ```bash
   echo 'YC_API_KEY=AQVN...' >> .env
   echo 'YC_FOLDER_ID=b1g...' >> .env
   node --env-file-if-exists=.env scripts/verify-vision-empirical.ts /path/to/passport.jpg
   ```
   Без image path → script использует synthetic 1×1 PNG → expects `api_error` (ОК для contract verification).

### Что искать в evidence

- `apps/backend/src/domains/epgu/vision/_evidence/real-vision-response.json` — raw response
- Console diff report покажет:
  - точный список `entities[].name` (resolve канон 9 vs live-research 12 divergence)
  - формат `expiration_date` (DD.MM.YYYY vs YYYY-MM-DD vs `"-"` for missing)
  - `number` field — есть ли пробел между серией и номером

### Стоимость

~0.1 ₽ за каждую recognize-call (Yandex Vision). Скрипт делает 1 call. Тривиально.

### 152-ФЗ опасность

Скрипт использует `x-data-logging-enabled: false` — Yandex НЕ retains request payload. Это canonical для passport scanning. Никакого consent flow не нужно для empirical verification (мы шлём synthetic data или твой собственный паспорт).

---

## 2. ЮKassa Test mode — `verify-yookassa-empirical.ts`

### Что нужно
```dotenv
YOOKASSA_TEST_SHOP_ID=...          # test shop ID (отличается от prod)
YOOKASSA_TEST_SECRET_KEY=...       # test secret key
```

### Шаги

1. **Зарегистрировать ЮKassa аккаунт**: https://yookassa.ru/joinups
   - **На этом этапе нужно ИП или ООО** для прод-режима.
   - **Test mode доступен и без подтверждения юр.лица** — useful для нашего empirical step. Но реальные платежи без юр.лица нельзя (ФНС/54-ФЗ).
   - **Юридическая прерогатива**: тебе нужно решить ИП vs ООО (УСН 6%/15% vs ОСН) до prod-launch. Это отдельная задача.
2. **Активировать Test mode**:
   - ЛК → правый верх toggle "Тест" / "Боевой"
   - Включить Test → URL меняется, видны test shop'ы
3. **Создать test shop**:
   - Test mode → магазины → создать тестовый магазин
   - Название любое (e.g. "Empirical verify Сочи")
4. **Скопировать credentials**:
   - Магазин → "Настройки" → "Реквизиты"
   - Скопировать `shopId` и `Secret key`
5. **Добавить в .env**:
   ```bash
   echo 'YOOKASSA_TEST_SHOP_ID=...' >> .env
   echo 'YOOKASSA_TEST_SECRET_KEY=...' >> .env
   ```
6. **Запуск**:
   ```bash
   node --env-file-if-exists=.env scripts/verify-yookassa-empirical.ts
   ```

### Что искать в evidence

- `apps/backend/src/domains/payment/_evidence/real-yookassa-*.json`
- Console diff проверит:
  - `Authorization: Basic` через HTTP Basic auth работает
  - `Idempotence-Key` (НЕ "Idempotency-Key") replay-safety
  - `vat_code: 11` (НДС 22% per 376-ФЗ 2026-01-01) принимается sandbox'ом
  - `payment_subject: "service"` для accommodation работает
  - `confirmation.confirmation_url` shape
  - `test: true` flag в response

### Webhook empirical (отдельный flow)

Webhook требует public HTTPS endpoint. Опции:
- **ngrok**: `ngrok http 3000` → public URL
- **cloudflared tunnel**: `cloudflared tunnel --url http://localhost:8787`
- **Bore.pub**: `bore local 3000 --to bore.pub`

После tunnel:
1. Test shop → "Настройки" → "HTTP-уведомления" → URL = `https://<your-tunnel>.ngrok-free.app/api/webhooks/yookassa`
2. Subscribe events: `payment.succeeded`, `payment.canceled`, `payment.waiting_for_capture`, `refund.succeeded`
3. Триггер тестового платежа → watch tunnel inspector + наш backend log

**Нет HMAC** в webhook (per canon). Только IP allowlist + GET-verification round-trip.

### Стоимость

ZERO. Test mode полностью бесплатный, sandbox-only.

---

## 3. Yandex Cloud Postbox — `verify-postbox-empirical.ts`

### Что нужно
```dotenv
POSTBOX_ACCESS_KEY_ID=YCAJ...
POSTBOX_SECRET_ACCESS_KEY=YC...
POSTBOX_VERIFIED_FROM=noreply@<your-verified-domain>
POSTBOX_VERIFIED_TO=<your-personal-email-for-test>
```

### Шаги

1. **Yandex Cloud аккаунт** (тот же, что и для Vision).
2. **Создать SA для Postbox**:
   - Console → IAM → Service Accounts → новая или re-use существующая
   - Roles: `postbox.sender`
3. **Issue static access keys** для SA:
   - SA → "Create access key" → "Static access key"
   - Скопировать `Key ID` (= AWS-style `accessKeyId`) и `Secret` (= `secretAccessKey`)
4. **Verify sender domain** (это самый длительный шаг):
   - Console → Postbox → Domains → Add domain
   - Выбрать DKIM verification: 2 CNAME либо 1 TXT record
   - Добавить DNS records у твоего регистратора (Beget / Cloudflare / Reg.ru)
   - Подождать DNS propagation (24h max, обычно 1-2h)
   - Re-verify через console
5. **Verify recipient** (sandbox mode требует verified recipient):
   - Console → Postbox → Email Addresses → Add → твой personal email
   - Подтвердить через email link
6. **Add to .env**:
   ```bash
   echo 'POSTBOX_ACCESS_KEY_ID=YCAJ...' >> .env
   echo 'POSTBOX_SECRET_ACCESS_KEY=YC...' >> .env
   echo 'POSTBOX_VERIFIED_FROM=noreply@your-verified-domain.ru' >> .env
   echo 'POSTBOX_VERIFIED_TO=youremail@example.com' >> .env
   ```
7. **Запуск**:
   ```bash
   node --env-file-if-exists=.env scripts/verify-postbox-empirical.ts
   ```

### Что искать в evidence

- `apps/backend/src/workers/_evidence/real-postbox-send.json`
- Console diff проверит:
  - HTTP 200 от endpoint `https://postbox.cloud.yandex.net/v2/email/outbound-emails`
  - `MessageId` non-empty
  - `region: ru-central1` SigV4 signing валидно
  - Email arrives in inbox (manual check)
  - DKIM-Signature header в raw email = RSA+SHA256

### DNS records — domain ownership

Для production launch нужны:
- **DKIM** — 2 CNAME (auto-generated Postbox console) — **обязательно**
- **SPF** — 1 TXT record `v=spf1 include:_spf.yandex.net ~all` — **обязательно** для anti-spam
- **DMARC** — 1 TXT record `v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain.ru; pct=20` — **рекомендуется**, ramp up до `p=reject` после 30 дней мониторинга

### Production access promotion (post-empirical)

Sandbox = только verified recipients. Promotion к production access (10M+/day):
- Console → Postbox → "Request production access"
- Заполнить justification (опишите use case — "transactional emails for HoReCa SaaS")
- Wait 1-2 business days (lead time не задокументирован)

### SMS gate (отдельный сервис от Postbox)

**НЕ часть empirical-batch** — `Yandex Cloud Notification Service` (SNS-compatible) — это отдельный сервис. Канон для Сочи HoReCa 2026:
- `Yandex Cloud Notification Service` — primary (Yandex-canon stack)
- SMS.ru (5.64–8.80 ₽/SMS) — backup если Yandex не дотягивает по deliverability

Этот выбор — для post-empirical M9.widget или M10.

### Стоимость

ZERO до 10 000 emails/мес (Postbox free tier). Verification calls в скрипте = 1 email.

---

## Что произойдёт после всех 3 empirical curl-pass:

1. **Vision evidence + diff** → 9-vs-12 entity divergence resolved → patch Mock + UI если real shape отличается от research-cache canon
2. **ЮKassa evidence** → подтверждены: status enum, Idempotence-Key replay, vat_code 11 acceptance, confirmation_url shape → можем строить behaviour-faithful YooKassa adapter (отдельный файл, не правка current generic Stub)
3. **Postbox evidence** → подтверждена SES v2 endpoint reachability + signing → подтверждение нашего PostboxAdapter контракта

После этого:
- Memory: write `project_empirical_batch_2026_04_29_results.md` с findings
- Update `project_empirical_batch_2026_04_29.md` со ссылкой "Phase 2 DONE" + дата
- Все Mock/Stub помечены `empirical-verified <date>` в комментариях
- M9.widget может стартовать на verified canonical surface

## Юридическая фаза (параллельный трек, тебе нужно проработать)

Это НЕ часть empirical-batch, но critical path для production launch:

- [ ] Юр.лицо: ИП vs ООО (для УСН-выбора, БизнесГуру/Контур.Бухгалтерия для бухгалтерии)
- [ ] 152-ФЗ — регистрация в реестре операторов ПД на pd.rkn.gov.ru (для passport scanning + email storage)
- [ ] 54-ФЗ — выбор ОФД (Платформа ОФД / Калуга Астрал / OFD.ru) для ЮKassa Чеки
- [ ] КЭП certificate для УЦ (~2500 ₽/год через СКБ Контур / Тензор) — для ЕПГУ submissions (M8.B parallel)
- [ ] Договор с банком для ЮKassa выплат (расчётный счёт ИП/ООО)
- [ ] Domain name + DNS hosting (для DKIM/SPF/DMARC + sender identity)
- [ ] Sender domain selection (`noreply@horeca-sochi.ru` или per-tenant)
- [ ] Согласие на обработку ПД template (152-ФЗ, отдельный документ от 2025-09-01)
- [ ] Public privacy policy + terms of service (152-ФЗ + ст. 18 38-ФЗ для маркетинговых рассылок)
- [ ] МВД ОВМ onboarding (для прод ЕПГУ, M8.B — multi-week)
