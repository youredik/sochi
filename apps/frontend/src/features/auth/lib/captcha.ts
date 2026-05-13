/**
 * Captcha enforcement flag — true when `VITE_YANDEX_CAPTCHA_SITE_KEY` is baked
 * into the build. Auth forms gate submit on `captchaToken` only when this is
 * true; dev (env unset) skips captcha entirely.
 *
 * Mirrors the backend gate in `apps/backend/src/lib/auth/captcha-gate.ts`,
 * which returns `disabled` when `SMARTCAPTCHA_SERVER_KEY` is unset. CI must
 * set both keys or neither: mismatch (frontend unset, backend set) yields
 * blanket 403 for every auth endpoint because forms cannot mint a token.
 */
export const captchaEnforced: boolean = Boolean(import.meta.env.VITE_YANDEX_CAPTCHA_SITE_KEY)
