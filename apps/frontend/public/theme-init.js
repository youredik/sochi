// FOUC-prevention (M9.1):
// Apply'ит .dark класс ПЕРЕД React mount чтобы избежать flash при reload
// на dark-странице. Storage key 'horeca-theme' match'ится с useThemeStore
// (src/lib/theme-store.ts) — НЕ менять без одновременного обновления.
// color-scheme управляется CSS-каскадом (:root + .dark), не JS-style.
//
// 2026-05-24 (Sprint C+ Round 6 — Security red team): extracted from inline
// <script> в index.html чтобы устранить inline-script dependency в strict
// CSP. External file = `script-src 'self'` достаточно, no hash needed.
;(() => {
	try {
		const t = localStorage.getItem('horeca-theme')
		const stored = t ? JSON.parse(t).state.theme : 'system'
		const d =
			stored === 'dark' ||
			(stored === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
		if (d) document.documentElement.classList.add('dark')
	} catch {}
})()
