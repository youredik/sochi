/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Hono backend base URL; defaults to same-origin via Vite dev proxy. */
	readonly VITE_API_URL?: string
	/**
	 * Yandex SmartCaptcha client site key. Unset → captcha widget renders
	 * nothing and dev forms skip the token field. Backend pairs via
	 * `SMARTCAPTCHA_SERVER_KEY` (unset → `disabled` gate); CI must set both
	 * or neither — mismatch yields silent skip (frontend) or blanket 403
	 * (backend).
	 */
	readonly VITE_YANDEX_CAPTCHA_SITE_KEY?: string
	/**
	 * Demo deployment flag — when `'true'`, captcha widget is suppressed
	 * regardless of `VITE_YANDEX_CAPTCHA_SITE_KEY` per `[[demo_strategy]]`
	 * (publicly-hosted demo runs friction-free; prospect должен попасть в
	 * продукт за 0 секунд). Backend pairs via `DEMO_DEPLOYMENT=true` —
	 * captcha-gate also bypasses validation. Mismatch yields silent
	 * skip (frontend) или blanket 403 (backend), same canon as
	 * VITE_YANDEX_CAPTCHA_SITE_KEY.
	 */
	readonly VITE_DEMO_DEPLOYMENT?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

// Lingui v6 compiled-catalog module shape. `@lingui/vite-plugin` transforms
// `.po` imports at build time into this structure (messages map keyed by
// stable id, values are ICU-compiled strings).
declare module '*.po' {
	export const messages: Record<string, string>
}
