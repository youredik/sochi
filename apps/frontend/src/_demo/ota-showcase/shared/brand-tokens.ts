/**
 * Round 9 — brand-safe approximate-not-exact palette tokens для demo OTA UIs.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 *
 * **Trademark guidance**: we use APPROXIMATE colors that evoke recognition
 * but are NOT 1-to-1 brand clones. The disclaimer banner + footer make the
 * non-affiliation explicit (Round 9 canon mandatory).
 *
 * **Why HSL**: deltas are visually meaningful (5deg hue shift vs exact hex),
 * making trademark dispute «we used hex X» harder to make stick. Cite
 * `feedback_no_emoji.md` aesthetic discipline — minimal tokens, no bloat.
 */

export const yandexBrandTokens = {
	// Approximate Yandex Travel red — NOT exact (real Yandex uses #FC3F1D)
	primary: 'hsl(11 92% 52%)', // ≈ #F94B25 — visibly distinct from real Yandex hex
	primaryHover: 'hsl(11 92% 45%)',
	primaryText: 'hsl(0 0% 100%)',
	bg: 'hsl(0 0% 99%)',
	bgMuted: 'hsl(220 14% 96%)',
	border: 'hsl(220 13% 91%)',
	text: 'hsl(220 30% 12%)',
	textMuted: 'hsl(220 9% 46%)',
	accent: 'hsl(48 100% 67%)', // Plus-cashback-y warm yellow
} as const

export const ostrovokBrandTokens = {
	// Approximate Островок red — NOT exact (real Островок uses #DF1933 family)
	primary: 'hsl(354 76% 50%)', // ≈ #D62034 — visibly distinct
	primaryHover: 'hsl(354 76% 42%)',
	primaryText: 'hsl(0 0% 100%)',
	bg: 'hsl(0 0% 99%)',
	bgMuted: 'hsl(210 16% 96%)',
	border: 'hsl(214 14% 89%)',
	text: 'hsl(214 32% 14%)',
	textMuted: 'hsl(214 11% 47%)',
	accent: 'hsl(166 71% 41%)', // ETG-style teal hint
} as const
