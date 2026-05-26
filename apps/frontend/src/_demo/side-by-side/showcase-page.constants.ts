/**
 * Round 12 — constants extracted из `showcase-page.tsx` so the .tsx module
 * exports ONLY React components (Fast Refresh canon + Biome
 * `useComponentExportOnlyModules` rule).
 */

/**
 * `localStorage` key for the admin session token. Presenter pastes the token
 * printed at backend boot into the showcase input field once; subsequent loads
 * restore from this key. Persists per browser-origin only.
 */
export const DEMO_SESSION_TOKEN_STORAGE_KEY = 'sepshn:demo-session-token'
