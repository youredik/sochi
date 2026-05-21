# Demo Prod Audit — 2026-05-21

**Source:** empirical verification против live `https://demo.sepshn.ru` + code-read backend/frontend
**Trigger:** user assignment full responsibility за functionality/deploy/infra
**Status:** READ phase done, FIX phase starting

---

## ✅ Confirmed working (empirical)

### Infrastructure

- `demo.sepshn.ru` apex → 200, SPA serves, cert valid
- `sepshn.ru` apex → 200, ANAME flattening работает
- `/health/ready` → 200 (ydb + adapters ok)
- 12 adapters in sandbox/mock mode (per handover 2026-05-19)
- YC org migrated к «Сэпшн» (cloud `b1gisf466novulsg0a0n`, folder demo `b1gtssqle0rbc3nv489v`)
- Container `bbaiifk6eb9hugkhplno` (sochi-backend-demo) ACTIVE
- Lockbox secret `sochi-backend-secrets` exists

### Demo functionality

- ✅ `DEMO_DEPLOYMENT=true` actually set в prod — verified via:
  - `GET /api/public/demo/inbox?email=...` returns 200 (endpoint exists, gated by `enabled` factory env-flag)
- ✅ Magic-link flow operational:
  - `POST /api/auth/sign-in/magic-link` → 200 `{"status":true}` (без captcha — bypassed на demo)
  - `GET /api/public/demo/inbox?email=...` returns captured `latestUrl` immediately после
  - Verify URL format: `https://demo.sepshn.ru/api/auth/magic-link/verify?token=...&callbackURL=...`
- ✅ DaData adapter wired (backend `createDaDataAdapter` registered в app.ts:198, identity routes mounted)
  - Falls back to mock if `DADATA_API_KEY` not set — demo tenants still functional

---

## 🔴 GAPS to fix

### Gap 1: Brand-rename incomplete (backend, user-visible)

Magic-link email subject все ещё «**HoReCa**» — это **первое впечатление** prospect'а:

- `apps/backend/src/lib/auth/magic-link-email.ts:28` — subject `«Вход в HoReCa — ваша одноразовая ссылка»`
- `apps/backend/src/lib/auth/magic-link-email.ts:33` — HTML H1 `«Вход в HoReCa-портал»`
- `apps/backend/src/lib/auth/magic-link-email.ts:43` — text alt
- `apps/backend/src/auth.ts:216` — WebAuthn `rpName: 'HoReCa Sochi'` (passkey enrollment dialog)
- `apps/backend/src/lib/ics-generator.ts:53` — `prodId.company: 'Sochi HoReCa'` (calendar invite)

User-impact: каждый сигнап → email с «HoReCa» в теме → confusion.

### Gap 2: Landing → /signup tupik

`sepshn.ru` и `demo.sepshn.ru` (один SPA) лендинг имеет только Telegram + Email buttons. **Нет ссылки на /signup, /login, или demo entry.** Self-discovery визитёр упирается в стену.

User-impact: только founder-led leads через outreach могут попробовать demo. Self-discovery acquisition = 0.

### Gap 3: DaData API key — unverified в Lockbox

`DADATA_API_KEY` опциональная в env (`apps/backend/src/env.ts:155-160`). При отсутствии → mock adapter (canonical Сочи demo set). Не знаем, set ли в prod Lockbox secret `sochi-backend-secrets`.

User-impact: setup wizard step 1 (ИНН entry → autofill) — works на mock, но может быть limited dataset. Real DaData = полная база юр.лиц РФ.

### Gap 4: Demo refresh cron не активен

Per `project_demo_strategy.md` §«Demo refresh cron» — должен раз в 6h reset prospect mutations → golden state. Не упомянут в handover_2026_05_19. Скорее всего не deployed.

User-impact: после нескольких визитёров demo «загрязняется» их test-данными. Через 1-2 недели demo деградирует визуально.

### Gap 5: E2E smoke for full demo funnel — отсутствует

Текущие e2e тесты не покрывают full path: anonymous → /signup → magic-link → DemoInbox → click → /welcome → org create → /setup → DaData → /o/{slug}/. Если что-то регрессирует, узнаем от первого живого визитёра.

User-impact: deploy regression может прорваться в prod.

---

## 🟡 Documented but acceptable defer (NOT halfmeasures, scoped out V1)

- PWA logo «H» → «С» (design + vite-pwa-assets-generator regen)
- Dedicated 1200×630 OG image (design)
- Sonner toast contrast project-wide fix (universal CSS-vars override)
- Privacy page юр.инфо ИП/ИНН/адрес (per user explicit defer until ИП registered)
- Postbox sender-domain DKIM/SPF/DMARC (только для real paying customers, Track C)
- Internal `@horeca/*` package imports (349) — никогда не видны клиенту

---

## Execution order

1. **Gap 1 (backend brand rename)** — high user-impact, low risk. ~30 min с тестами.
2. **Gap 2 (landing /signup link)** — high user-impact, обновить anti-regression test.
3. **Gap 3 (DaData verify)** — verify, then either ADD key или document mock-fallback OK.
4. **Gap 5 (e2e smoke)** — full funnel coverage. ~1-2h.
5. **Gap 4 (demo refresh cron)** — отложить если demo seed clean остаётся ОК через 1 неделю; иначе срочно.

---

## Cross-refs

- [[project_demo_strategy]] — always-on demo canon
- [[feedback_demo_inbox_canon]] — DemoInboxAdapter architecture
- [[feedback_auth_passwordless_canon]] — magic-link sole entrypoint
- [[handover_2026_05_19]] — production state snapshot
- [[project_landing_phase1_done_2026_05_21]] — landing shipping
