/**
 * Tuple-allowlist for axe-core known noise — M9.widget.7 / A5.3 / D16.
 *
 * Per `plans/m9_widget_7_canonical.md` §2 D16 + R2 §2:
 *   «axe-core@4.11.4 EXACT pin + `disableRules: []` blanket-disable banned;
 *    tuple-allowlist pattern только. Shadow-DOM false-positive class needs
 *    surgical disable, не blanket».
 *
 * Each entry is `{ ruleId, selectorContains, reason }`. Violations matching
 * BOTH ruleId AND a substring of any node's `target` selector are filtered
 * out. Everything else fails the test.
 *
 * **Rule:** when adding an entry, document WHY in `reason` (regression vector,
 * library upstream issue, RFC link). Annual audit removes entries fixed
 * upstream.
 *
 * **NEVER add a blanket `ruleId` without `selectorContains` — that defeats
 * the whole tuple-allowlist canon.**
 */

import type AxeBuilder from '@axe-core/playwright'

type AxeResults = Awaited<ReturnType<InstanceType<typeof AxeBuilder>['analyze']>>
type AxeViolation = AxeResults['violations'][number]

export interface AxeKnownNoise {
	readonly ruleId: string
	readonly selectorContains: string
	readonly reason: string
}

/**
 * Canonical allowlist — keep small. Add entry ONLY after:
 *   1. Confirming it's an upstream axe-core / library bug (Lit shadow DOM,
 *      browser engine quirk, etc.)
 *   2. Filing an upstream issue + linking in `reason`
 *   3. Adding TODO с deadline для re-evaluation
 */
export const KNOWN_NOISE: readonly AxeKnownNoise[] = [
	// Currently empty — A5.3 baseline. Add only when concrete upstream noise
	// surfaces during the matrix. Each addition requires a code review.
] as const

/**
 * Filter axe violations against the known-noise tuple-allowlist.
 *
 * Matching semantics (per-rule, per-node):
 *   - For each violation v, look up entries with v.id === ruleId.
 *   - For each matching entry, drop nodes whose ANY target selector
 *     contains the entry's `selectorContains` substring.
 *   - If after filtering all nodes are gone, drop the violation entirely.
 *
 * @returns filtered violations array (may be empty); use directly with
 *          `expect(filtered).toEqual([])`.
 */
export function filterKnownNoise(violations: readonly AxeViolation[]): readonly AxeViolation[] {
	const out: AxeViolation[] = []
	for (const v of violations) {
		const rules = KNOWN_NOISE.filter((n) => n.ruleId === v.id)
		if (rules.length === 0) {
			out.push(v)
			continue
		}
		const remainingNodes = v.nodes.filter((n) => {
			const targetStr = n.target.flat().join(' ')
			return !rules.some((r) => targetStr.includes(r.selectorContains))
		})
		if (remainingNodes.length > 0) {
			out.push({ ...v, nodes: remainingNodes })
		}
	}
	return out
}

/** Standard WCAG tag set for AA conformance — single source for all tests. */
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const
