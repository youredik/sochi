import { i18n } from '@lingui/core'
import { messages as ruMessages } from '../../locales/ru/messages.po'

/**
 * Lingui v6 i18n bootstrap.
 *
 * - Catalog compiled on-the-fly by `@lingui/vite-plugin` — no separate
 *   `lingui compile` step in dev.
 * - ru-RU is the only начальный locale. Activation is synchronous to avoid a
 *   render-flash on first paint; when en/kz are added, use `loadLocale()`
 *   that dynamic-imports the catalog before calling `activate()`.
 * - Re-exported `i18n` singleton is the same reference the `<I18nProvider>`
 *   subscribes to, so imperative `i18n._()` calls in non-component code
 *   (e.g. toast callbacks) stay in sync with the React tree.
 */

const DEFAULT_LOCALE = 'ru'

export function setupI18n(): typeof i18n {
	i18n.load({ ru: ruMessages })
	i18n.activate(DEFAULT_LOCALE)
	return i18n
}

export { i18n }
