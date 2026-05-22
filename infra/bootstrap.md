# Sepshn IaC bootstrap — one-time manual steps

Этот документ описывает ручные шаги для resources, которые требуют
**bootstrap-уровня secrets/keys** не управляемых через TF state.

Per Terraform provider limitations (issue
[yandex-cloud/terraform-provider-yandex#492](https://github.com/yandex-cloud/terraform-provider-yandex/issues/492))

- DKIM private-key security boundary — некоторые secrets создаются вне TF
  через `yc` CLI, потом TF читает via data source или secret_id reference.

**Pre-flight всегда**: `bash scripts/yc-preflight.sh` — verify yc profile +
cloud + folder соответствуют sepshn-new. Иначе ресурсы попадут в чужой cloud.

---

## Phase 1 — SmartCaptcha bootstrap

### Шаг 1.1. Первый `terraform apply`

`smartcaptcha.tf` создаёт captcha resource. После apply — captcha_id в output:

```bash
cd infra && terraform output -raw smartcaptcha_id
# bpnXXXXXXXXXXXXXXXXX
```

### Шаг 1.2. Fetch server-key (manual one-time per captcha lifecycle)

```bash
yc smartcaptcha captcha get-secret-key <captcha-id>
# server-key: ysc2_XXXXXXXXXXXXXXXXX
```

### Шаг 1.3. Создать Lockbox secret

```bash
# Используем infra folder (shared secrets boundary, см. lockbox.tf canon).
# Если хочется per-env — использовать demo folder b1gtssqle0rbc3nv489v.
SECRET_ID=$(yc lockbox secret create \
  --folder-id b1gp4bo808jr6qvrnltu \
  --name sepshn-smartcaptcha-server-key \
  --description "SmartCaptcha server-key (ysc2_...) — captcha-gate.ts validation" \
  --payload '[{"key":"SMARTCAPTCHA_SERVER_KEY","text_value":"ysc2_REPLACE_ME"}]' \
  --format json | jq -r '.id')

VERSION_ID=$(yc lockbox secret list-versions $SECRET_ID --format json | jq -r '.[0].id')

echo "secret_id  = $SECRET_ID"
echo "version_id = $VERSION_ID"
```

### Шаг 1.4. Update `infra/terraform.tfvars`

```hcl
smartcaptcha_lockbox_secret_id  = "e6q..."  # из шага 1.3
smartcaptcha_lockbox_version_id = "e6q..."
```

### Шаг 1.5. Update `.sourcecraft/ci.yaml` — frontend build env

```yaml
- name: build
  env:
    VITE_DEMO_DEPLOYMENT: 'true'
    VITE_YANDEX_CAPTCHA_SITE_KEY: 'ysc1_REPLACE_ME' # client_key из smartcaptcha TF output
```

(`client_key` public по design — безопасно committed в repo.)

### Шаг 1.6. `terraform apply` второй раз + push

- Container mounts `SMARTCAPTCHA_SERVER_KEY` env var
- Frontend bundle includes `VITE_YANDEX_CAPTCHA_SITE_KEY`
- Magic-link form renders SmartCaptcha widget
- Backend `evaluateCaptchaGate` validates tokens against Yandex API

### Шаг 1.7. Empirical verify

Visit `https://demo.sepshn.ru/login` — captcha widget visible на форме.
Submit без solving → 403 «Captcha verification required». Solve →
магик-линк отправляется.

---

## Phase 2 — Postbox bootstrap (когда готовы к real email)

**Skeleton**: `infra/postbox.tf.skeleton` (отключён от apply).

### Шаг 2.1. Generate DKIM keypair

```bash
mkdir -p /tmp/sepshn-dkim
openssl genrsa -out /tmp/sepshn-dkim/private.pem 2048

# Public key для DNS TXT — base64 single-line без PEM headers
openssl rsa -in /tmp/sepshn-dkim/private.pem -pubout \
  | grep -v 'BEGIN\|END' | tr -d '\n' > /tmp/sepshn-dkim/public_dns.txt
cat /tmp/sepshn-dkim/public_dns.txt
```

### Шаг 2.2. Lockbox для private key

```bash
DKIM_SECRET_ID=$(yc lockbox secret create \
  --folder-id b1gp4bo808jr6qvrnltu \
  --name sepshn-postbox-dkim \
  --description "Postbox DKIM private key (2048-bit RSA) — postbox.tf data source" \
  --payload "[{\"key\":\"POSTBOX_DKIM_PRIVATE_KEY\",\"text_value\":\"$(cat /tmp/sepshn-dkim/private.pem)\"}]" \
  --format json | jq -r '.id')

echo "dkim_secret_id = $DKIM_SECRET_ID"
```

### Шаг 2.3. Yandex 360 для домена (бесплатно)

Открыть [admin.yandex.ru](https://admin.yandex.ru/) → подключить sepshn.ru
→ создать почтовые ящики:

- `dmarc@sepshn.ru` — для DMARC aggregate reports (DNS rua= target)
- `hi@sepshn.ru` — для human contact (reply-to в transactional emails)

DNS records (MX, Y360 DKIM, yandex-verification) — уже в `dns.tf`.

### Шаг 2.4. Update `infra/terraform.tfvars`

```hcl
lockbox_postbox_dkim_secret_id = "e6q..."  # из шага 2.2
postbox_dkim_public_key        = "MIIBIjANBgkqhkiG9w0BAQEFAAOC..."  # из шага 2.1
```

### Шаг 2.5. Активировать postbox.tf

```bash
mv infra/postbox.tf.skeleton infra/postbox.tf
```

### Шаг 2.6. Update `dns.tf` apex SPF — добавить `_spf.cloud.yandex.net` include

### Шаг 2.7. `terraform apply`

Создаст:

- Postbox identity для `sepshn.ru`
- DKIM CNAME records (postbox.\_domainkey.sepshn.ru)
- DMARC TXT record (`p=none` — мониторинг)
- Sender SA + static keys (Lockbox bundle update)

Postbox automatically verifies domain через DKIM CNAME (~5min).

### Шаг 2.8. Backend wire — PostboxAdapter

Заменить `MailpitAdapter` (dev) / capture-only DemoInbox (demo) на dual-mode
factory:

- `DEMO_DEPLOYMENT=true` + `POSTBOX_ENABLED=true` → DemoInbox + Postbox
  parallel (panel UI works для test emails, real emails delivered)
- `DEMO_DEPLOYMENT=false` → Postbox only

### Шаг 2.9. Empirical verify

```bash
curl -X POST https://demo.sepshn.ru/api/auth/sign-in/magic-link \
  -H 'Content-Type: application/json' \
  -d '{"email":"youredik@gmail.com","callbackURL":"https://demo.sepshn.ru/","captchaToken":"<from-captcha>"}'
# 200 OK

# Check Gmail inbox → magic-link письмо arrived с правильным DKIM/SPF/DMARC
# Использовать mail-tester.com для spam-score validation (target ≥ 9/10)
```

---

## Phase 3 — DMARC roll-out (post-Phase 2, 2-4 недели)

- Week 0-2 после Phase 2: `p=none` — monitoring only (current canon)
- Week 2-4: → `p=quarantine` (Gmail/Yahoo marks как junk но delivers)
- Week 4+: → `p=reject` (RFC-strict hard-fail)
- SPF: `~all` → `-all` (после DMARC reject stable)

Update `infra/postbox.tf` (when active) DMARC recordset `data` array.
