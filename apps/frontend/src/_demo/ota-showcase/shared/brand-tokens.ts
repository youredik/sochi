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

/**
 * Round 12 a11y fix (R12V-3/R12V-4 — Preview MCP axe-core finds):
 *   - `primary` 52% → 42% lightness: white-on-primary contrast 3.77:1 → ≥4.5:1
 *     (passes WCAG 2.2 AA for normal text). Side-benefit: darker color is
 *     visually FURTHER from real brand hex → strengthens «approximate-not-
 *     exact» trademark-safety claim, not weakens it.
 *   - `textMuted` 46/47% → 32% lightness: muted-text-on-bgMuted contrast
 *     ~4.17:1 → ≥7:1 (passes WCAG 2.2 AAA — nav «Отели» в header).
 *   - `primaryHover` symmetrically darkened so hover stays visually
 *     distinguishable from primary without re-failing contrast.
 */
export const yandexBrandTokens = {
	// Approximate Yandex Travel red — NOT exact (real Yandex uses #FC3F1D).
	// Round 12 — lightness 52% → 42% for WCAG AA white-text contrast.
	primary: 'hsl(11 92% 42%)', // ≈ #C42B08 — darker, more distinct from real
	primaryHover: 'hsl(11 92% 33%)',
	primaryText: 'hsl(0 0% 100%)',
	bg: 'hsl(0 0% 99%)',
	bgMuted: 'hsl(220 14% 96%)',
	border: 'hsl(220 13% 91%)',
	text: 'hsl(220 30% 12%)',
	// Round 12 — lightness 46% → 32% for WCAG AA on bgMuted.
	textMuted: 'hsl(220 9% 32%)',
	accent: 'hsl(48 100% 67%)', // Plus-cashback-y warm yellow
} as const

export const ostrovokBrandTokens = {
	// Approximate Островок red — NOT exact (real Островок uses #DF1933 family).
	// Round 12 — lightness 50% → 42% for WCAG AA white-text contrast.
	primary: 'hsl(354 76% 42%)', // ≈ #BC1A2A — darker, more distinct
	primaryHover: 'hsl(354 76% 33%)',
	primaryText: 'hsl(0 0% 100%)',
	bg: 'hsl(0 0% 99%)',
	bgMuted: 'hsl(210 16% 96%)',
	border: 'hsl(214 14% 89%)',
	text: 'hsl(214 32% 14%)',
	// Round 12 — lightness 47% → 32% for WCAG AA on bgMuted.
	textMuted: 'hsl(214 11% 32%)',
	accent: 'hsl(166 71% 41%)', // ETG-style teal hint
} as const
