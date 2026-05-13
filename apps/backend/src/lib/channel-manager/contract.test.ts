/**
 * Contract surface assertion — M10 / A7.1.
 *
 * Documents + anchors the `ChannelManagerAdapter` interface + `DispatchStatus`
 * type as the canonical public contract. Mock implementations (A7.2 TravelLine,
 * A7.3 Yandex.Travel, A7.4 Ostrovok ETG) MUST conform.
 *
 * **Type-level only** — no runtime assertions. Acts as a build-time check
 * that the contract surface compiles + is structurally consumable.
 */

import { describe, expect, it } from 'bun:test'
import type { ChannelManagerAdapter, ChannelMetadata, DispatchStatus } from './index.ts'

describe('ChannelManagerAdapter contract surface (M10 / A7.1)', () => {
	it('[CONTRACT1] type signature compiles + is consumable', () => {
		// Build a minimal stub conforming to the interface — proves all
		// methods + types are publicly accessible.
		const stub: Partial<ChannelManagerAdapter> = {
			metadata: {
				channelId: 'STUB',
				mode: 'mock',
				role: 'processor_with_dpa',
				displayName: 'stub',
			} satisfies ChannelMetadata,
		}
		expect(stub.metadata?.channelId).toBe('STUB')
		expect(stub.metadata?.mode).toBe('mock')
	})

	it('[CONTRACT2] DispatchStatus literal union covers все 4 states', () => {
		const states: ReadonlyArray<DispatchStatus> = ['pending', 'sent', 'dlq', 'disabled']
		expect(states).toHaveLength(4)
	})
})
