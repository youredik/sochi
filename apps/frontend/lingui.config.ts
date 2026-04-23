import type { LinguiConfig } from '@lingui/conf'
import { formatter } from '@lingui/format-po'

/**
 * Lingui v6 configuration.
 *
 * - ru-RU is the начальный locale. Future en/kz locales extracted to the same
 *   catalogs folder by running `pnpm lingui extract`.
 * - `.po` (gettext) format — translator-friendly, diff-clean in PRs.
 *   v6 breaking change: `format` is now a formatter *function* (not the
 *   string "po") produced by `@lingui/format-po`. `lineNumbers: false`
 *   keeps diffs stable when source-file lines shift.
 * - Macro-based extraction via `@lingui/babel-plugin-lingui-macro` (wired
 *   in vite.config.ts). Runtime catalogs compiled by `@lingui/vite-plugin`.
 */
const config: LinguiConfig = {
	locales: ['ru'],
	sourceLocale: 'ru',
	fallbackLocales: { default: 'ru' },
	catalogs: [
		{
			path: '<rootDir>/src/locales/{locale}/messages',
			include: ['<rootDir>/src'],
		},
	],
	format: formatter({ lineNumbers: false }),
}

export default config
