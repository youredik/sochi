/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Hono backend base URL; defaults to same-origin via Vite dev proxy. */
	readonly VITE_API_URL?: string
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
