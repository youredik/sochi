/**
 * Captcha enforcement flag — true when `VITE_YANDEX_CAPTCHA_SITE_KEY` is baked
 * into the build. Auth forms gate submit on `captchaToken` только когда this is
 * true; dev (env unset) skips captcha widget entirely.
 *
 * **2026-05-22 decoupled от DEMO_DEPLOYMENT** per user-mandate: ботам всё
 * равно демо это или prod — magic-link форма должна быть защищена captcha
 * в обоих режимах. Если ключ есть → enforce. Раньше `isDemoDeployment=true`
 * подавлял captcha (canonical «убрать friction для prospects»), но эмпирически
 * это окно для flood-атак на DemoInbox (MAX_TOTAL_RECIPIENTS=500 квота),
 * который ломает demo для других prospects.
 *
 * Mirrors the backend gate в `apps/backend/src/lib/auth/captcha-gate.ts`,
 * который returns `disabled` когда `SMARTCAPTCHA_SERVER_KEY` unset. CI
 * setup: VITE_YANDEX_CAPTCHA_SITE_KEY (build env) paired с SMARTCAPTCHA_
 * SERVER_KEY (container env via Lockbox). Mismatch (frontend set, backend
 * unset) → backend reject every captcha'd request. Set both или neither.
 */
export const captchaEnforced: boolean = Boolean(import.meta.env.VITE_YANDEX_CAPTCHA_SITE_KEY)
