/**
 * `<RoomsBulkAddSheet>` — strict tests focused на the floor field bounds
 * (B5.bis 2026-05-15). The bulk-add sheet had no component test file
 * before this commit; the only coverage came from the parent
 * `inventory-rooms-page` integration. Per `[[strict_tests]]` canon —
 * exact-value + adversarial.
 *
 * Pre-done audit (this initial slice — focused on B5.bis scope, not full
 * form coverage — каждое поле полного покрытия waits для its own slice):
 *
 *   Render:
 *     [R1] mount calls render с roomType prop; floor field default '1';
 *          FieldError absent
 *
 *   Inline-bounds (B5.bis — floor mirrors server floorSchema -5..50):
 *     [B1] floor='1.5' (decimal — passes <input type=number>, fails regex)
 *          → «Целое число». NOTE: cannot test 'abc' because happy-dom
 *          coerces non-numeric input value к '' silently; that path is
 *          covered directly by helper test [E2] via `safeParse('abc')`.
 *     [B2] floor='-6' → «Не меньше -5»
 *     [B3] floor='51' → «Не больше 50»
 *     [B4] floor='' (cleared) → NO error («Если пусто — этаж не присваивается»)
 *     [B5] floor='50' (max boundary) → no error
 *
 *   Submit shape (exact-value + immutable + partial-failure):
 *     [S1] success path: bulk.mutateAsync called с EXACT
 *          { roomTypeId, startNumber, endNumber, floor } — floor included
 *          because default '1' (not empty)
 *     [S2] empty floor: payload OMITS floor (per «Если пусто — этаж не
 *          присваивается» semantic; spread `...(floor !== undefined ?
 *          { floor } : {})` is the canonical immutable-when-absent pattern)
 *     [S3] partial-failure result: setResult shows created + failed rows;
 *          sheet stays open (only auto-closes when failed.length === 0)
 *
 * NOTE: startNumber/endNumber upper bound + cross-field refine (endNumber
 * ≥ startNumber, range ≤ 500) — separate backlog item.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

type BulkArg = {
	roomTypeId: string
	startNumber: number
	endNumber: number
	floor?: number
}
type BulkResult = {
	created: ReadonlyArray<{ id: string; number: string }>
	failed: ReadonlyArray<{ number: string; error: string }>
}
const bulkMutateAsync = mock<(arg: BulkArg) => Promise<BulkResult>>(async () => ({
	created: [],
	failed: [],
}))

await mock.module('@tanstack/react-query', () => ({
	useMutation: () => ({ mutateAsync: bulkMutateAsync, isPending: false }),
	useQuery: () => ({ data: undefined, error: null, isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

await mock.module('sonner', () => ({
	toast: { success: () => {}, error: () => {}, warning: () => {} },
}))

const { RoomsBulkAddSheet } = await import('./rooms-bulk-add-sheet.tsx')

const ROOM_TYPE = {
	id: 'rt-1',
	tenantId: 't',
	propertyId: 'prop-1',
	name: 'Стандартный',
	description: null,
	maxOccupancy: 2,
	baseBeds: 1,
	extraBeds: 0,
	areaSqm: null,
	inventoryCount: 10,
	isActive: true,
	createdAt: '',
	updatedAt: '',
} as const

beforeEach(() => {
	bulkMutateAsync.mockReset()
	bulkMutateAsync.mockImplementation(async () => ({ created: [], failed: [] }))
})

afterEach(cleanup)

describe('RoomsBulkAddSheet — render', () => {
	it('[R1] mounts с roomType; floor default «1»; no FieldError на mount', () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		expect(screen.queryByText('Добавить номера в категорию «Стандартный»')).not.toBe(null)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		expect(floor.value).toBe('1')
		// No range error visible on initial render.
		expect(screen.queryByText('Не меньше -5')).toBe(null)
		expect(screen.queryByText('Не больше 50')).toBe(null)
	})
})

describe('RoomsBulkAddSheet — floor inline-bounds (B5.bis)', () => {
	it('[B1] floor=«1.5» (decimal — fails regex) surfaces «Целое число»', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '1.5' } })
		await waitFor(() => {
			expect(screen.queryByText('Целое число')).not.toBe(null)
		})
	})

	it('[B2] floor=-6 surfaces «Не меньше -5» (mirrors server min)', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '-6' } })
		await waitFor(() => {
			expect(screen.queryByText('Не меньше -5')).not.toBe(null)
		})
	})

	it('[B3] floor=51 surfaces «Не больше 50» (mirrors server max)', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '51' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 50')).not.toBe(null)
		})
	})

	it('[B4] floor cleared («») emits NO error — optional field semantic', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		// First introduce an error, then clear, ensure error gone.
		fireEvent.change(floor, { target: { value: '99' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 50')).not.toBe(null)
		})
		fireEvent.change(floor, { target: { value: '' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 50')).toBe(null)
		})
		expect(screen.queryByText('Целое число')).toBe(null)
		expect(screen.queryByText('Введите число')).toBe(null)
	})

	it('[B5] floor=50 (max boundary) — no error', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '50' } })
		// Wait a tick to let validator run.
		await new Promise((r) => setTimeout(r, 20))
		expect(screen.queryByText('Не больше 50')).toBe(null)
		expect(screen.queryByText('Целое число')).toBe(null)
	})
})

describe('RoomsBulkAddSheet — submit shape (exact-value + immutable)', () => {
	it('[S1] success: bulk.mutateAsync called с exact payload incl. floor (default «1»)', async () => {
		bulkMutateAsync.mockImplementation(async () => ({
			created: [
				{ id: 'r1', number: '201' },
				{ id: 'r2', number: '202' },
			],
			failed: [],
		}))
		const onOpenChange = mock()
		render(
			<RoomsBulkAddSheet
				open
				onOpenChange={onOpenChange}
				propertyId="prop-1"
				roomType={ROOM_TYPE}
			/>,
		)
		const startInput = screen.getByLabelText('Первый номер') as HTMLInputElement
		fireEvent.change(startInput, { target: { value: '201' } })
		const endInput = screen.getByLabelText('Последний номер') as HTMLInputElement
		fireEvent.change(endInput, { target: { value: '202' } })

		// Button shows rangeSize. Wait for reactive computation.
		await waitFor(() => {
			expect(screen.queryByText(/Создать 2 номеров/)).not.toBe(null)
		})

		fireEvent.click(screen.getByRole('button', { name: /Создать 2 номеров/ }))

		await waitFor(() => {
			expect(bulkMutateAsync).toHaveBeenCalledTimes(1)
		})
		// floor included because default '1' is non-empty.
		expect(bulkMutateAsync).toHaveBeenCalledWith({
			roomTypeId: 'rt-1',
			startNumber: 201,
			endNumber: 202,
			floor: 1,
		})
		// Sheet auto-closes on full success.
		expect(onOpenChange.mock.calls.some((c) => c[0] === false)).toBe(true)
	})

	it('[S2] empty floor → payload OMITS floor entirely (immutable-when-absent)', async () => {
		bulkMutateAsync.mockImplementation(async () => ({
			created: [{ id: 'r1', number: '301' }],
			failed: [],
		}))
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		fireEvent.change(screen.getByLabelText('Первый номер'), { target: { value: '301' } })
		fireEvent.change(screen.getByLabelText('Последний номер'), { target: { value: '301' } })
		// Clear floor → empty → omit
		fireEvent.change(screen.getByLabelText('Этаж (необязательно)'), { target: { value: '' } })

		await waitFor(() => {
			expect(screen.queryByText(/Создать 1 номер/)).not.toBe(null)
		})

		fireEvent.click(screen.getByRole('button', { name: /Создать 1 номер/ }))

		await waitFor(() => {
			expect(bulkMutateAsync).toHaveBeenCalledTimes(1)
		})
		// Critical: floor key MUST be absent (not floor: 0, not floor: NaN).
		const call = bulkMutateAsync.mock.calls[0]?.[0] as unknown as Record<string, unknown>
		expect('floor' in call).toBe(false)
		expect(call).toEqual({
			roomTypeId: 'rt-1',
			startNumber: 301,
			endNumber: 301,
		})
	})

	it('[S3] partial-failure: failed rows rendered; sheet stays open (no onOpenChange(false))', async () => {
		bulkMutateAsync.mockImplementation(async () => ({
			created: [{ id: 'r1', number: '401' }],
			failed: [{ number: '402', error: 'duplicate' }],
		}))
		const onOpenChange = mock()
		render(
			<RoomsBulkAddSheet
				open
				onOpenChange={onOpenChange}
				propertyId="prop-1"
				roomType={ROOM_TYPE}
			/>,
		)
		fireEvent.change(screen.getByLabelText('Первый номер'), { target: { value: '401' } })
		fireEvent.change(screen.getByLabelText('Последний номер'), { target: { value: '402' } })

		await waitFor(() => {
			expect(screen.queryByText(/Создать 2 номеров/)).not.toBe(null)
		})

		fireEvent.click(screen.getByRole('button', { name: /Создать 2 номеров/ }))

		await waitFor(() => {
			expect(screen.queryByText(/не удалось 1/)).not.toBe(null)
		})
		// Failed row visible с error message
		expect(screen.queryByText(/402 — duplicate/)).not.toBe(null)
		// Sheet NOT auto-closed on partial failure
		expect(onOpenChange.mock.calls.some((c) => c[0] === false)).toBe(false)
	})
})
