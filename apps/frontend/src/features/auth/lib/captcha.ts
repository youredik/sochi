/**
 * Captcha enforcement flag — true when `VITE_YANDEX_CAPTCHA_SITE_KEY` is baked
 * into the build AND the deployment is NOT a demo deployment. Auth forms gate
 * submit on `captchaToken` only when this is true; dev (env unset) and demo
 * deployment (`VITE_DEMO_DEPLOYMENT=true`) skip captcha entirely.
 *
 * **Demo deployment** per `[[demo_strategy]]`: public hosted demo (e.g.
 * `demo.sochi.ru`) serves prospects evaluating the product. Captcha friction
 * на signup is a deal-breaker для acquisition flow — set
 * `VITE_DEMO_DEPLOYMENT=true` on demo builds to suppress. Backend pairs via
 * `DEMO_DEPLOYMENT=true` так captcha-gate bypasses validation symmetrically.
 *
 * Mirrors the backend gate in `apps/backend/src/lib/auth/captcha-gate.ts`,
 * which returns `disabled` when `SMARTCAPTCHA_SERVER_KEY` is unset OR
 * `DEMO_DEPLOYMENT=true`. CI must set both keys (frontend + backend) and
 * both demo-flags consistently: mismatch (frontend unset, backend set OR
 * vice-versa) yields blanket 403 for every auth endpoint because forms
 * cannot mint a token AND the gate refuses non-tokened requests.
 *
 * `VITE_DEMO_DEPLOYMENT` is a STRING env-var (Vite inlines as string at
 * build); compare к literal `'true'` rather than `Boolean()` cast — empty
 * string и `'false'` would otherwise both round-trip к `false` correctly
 * but explicit string-match is safer для future maintainers.
 */
const isDemoDeployment = import.meta.env.VITE_DEMO_DEPLOYMENT === 'true'

export const captchaEnforced: boolean =
	!isDemoDeployment && Boolean(import.meta.env.VITE_YANDEX_CAPTCHA_SITE_KEY)
