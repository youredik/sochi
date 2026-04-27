/**
 * Idempotency-Key utility — centralized so callers don't drift between
 * `crypto.randomUUID()` inline, `generateIdempotencyKey()` from bookings,
 * and any future variant. One module, one canon.
 *
 * Pattern (per `feedback_form_pattern_rule.md` + `project_m6_7_frontend_research.md`):
 *
 *   1. **Modal/Dialog flows** — generate ONCE per mount via
 *      `useIdempotencyKey()` hook. The dialog UNMOUNTS on submit, so each
 *      open gives a fresh key. Auto-retry by TanStack Query reuses the
 *      vars (same key) → server replays.
 *
 *   2. **Long-lived form flows (wizards)** — generate FRESH on each user-
 *      initiated save click via `freshIdempotencyKey()` inside the click
 *      handler. The form persists across saves, so a `useMemo` per mount
 *      would over-share the key across distinct save-actions.
 *
 * Wire format: UUIDv4 (lowercase, hyphenated, 36 chars). Backend validates
 * against IETF draft-07 (sha-256 fingerprint of body keyed by this UUID).
 */

import { useMemo } from 'react'

/** Generate a fresh UUIDv4 for one mutation attempt. */
export function freshIdempotencyKey(): string {
	return crypto.randomUUID()
}

/**
 * React hook — stable key for the lifetime of one component mount.
 * Use for dialogs/sheets that unmount on submit.
 *
 * Do NOT use for long-lived forms (wizards) where multiple saves happen
 * in one mount lifecycle — use `freshIdempotencyKey()` inside the click
 * handler instead.
 */
export function useIdempotencyKey(): string {
	return useMemo(() => freshIdempotencyKey(), [])
}
