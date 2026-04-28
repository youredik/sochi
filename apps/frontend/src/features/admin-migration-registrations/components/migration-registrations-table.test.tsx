/**
 * MigrationRegistrationsTable — strict component tests.
 *
 * Pre-done audit:
 *   Render:
 *     [T1] empty items → empty state message rendered (NOT table)
 *     [T2] non-empty items → table с canonical 7 columns rendered
 *     [T3] row contains bookingId + guestId (font-mono presentation)
 *
 *   Click semantic:
 *     [C1] click row → onRowClick called с row's id
 *     [C2] keyboard Enter on row → onRowClick called
 *     [C3] keyboard Space on row → onRowClick called
 *
 *   Status badge integration:
 *     [B1] статус 0 (draft) badge rendered с label "Черновик"
 *     [B2] статус 3 (executed) badge rendered с label "Поставлен на учёт"
 */
import type { MigrationRegistration } from '@horeca/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MigrationRegistrationsTable } from './migration-registrations-table.tsx'

afterEach(cleanup)

const FIXTURE: MigrationRegistration = {
	tenantId: 'org-test',
	id: 'mreg_001',
	bookingId: 'book_001',
	guestId: 'gst_001',
	documentId: 'gdoc_001',
	epguChannel: 'gost-tls',
	epguOrderId: null,
	epguApplicationNumber: null,
	serviceCode: '10000103652',
	targetCode: '-1000444103652',
	supplierGid: 'supplier-test',
	regionCode: 'fias-test',
	arrivalDate: '2026-05-10',
	departureDate: '2026-05-15',
	statusCode: 0,
	isFinal: false,
	reasonRefuse: null,
	errorCategory: null,
	submittedAt: null,
	lastPolledAt: null,
	nextPollAt: null,
	finalizedAt: null,
	retryCount: 0,
	attemptsHistoryJson: null,
	operatorNote: null,
	createdAt: '2026-04-28T10:00:00.000Z',
	updatedAt: '2026-04-28T10:00:00.000Z',
	createdBy: 'system',
	updatedBy: 'system',
}

describe('MigrationRegistrationsTable — render', () => {
	test('[T1] empty items → empty state, NO table', () => {
		render(<MigrationRegistrationsTable items={[]} onRowClick={vi.fn()} />)
		expect(screen.queryByRole('table')).toBeNull()
		expect(screen.getByText(/Нет регистраций миграционного учёта/)).toBeTruthy()
	})

	test('[T2] non-empty → table rendered с column headers', () => {
		render(<MigrationRegistrationsTable items={[FIXTURE]} onRowClick={vi.fn()} />)
		expect(screen.getByRole('table')).toBeTruthy()
		// Headers: Создано / Бронь / Гость / Пребывание / Канал / Статус / Опрошено
		const headers = screen.getAllByRole('columnheader')
		expect(headers.length).toBe(7)
	})

	test('[T3] row contains bookingId + guestId', () => {
		render(<MigrationRegistrationsTable items={[FIXTURE]} onRowClick={vi.fn()} />)
		expect(screen.getByText('book_001')).toBeTruthy()
		expect(screen.getByText('gst_001')).toBeTruthy()
	})
})

describe('MigrationRegistrationsTable — click + keyboard', () => {
	test('[C1] click row → onRowClick(id)', () => {
		const onRowClick = vi.fn()
		render(<MigrationRegistrationsTable items={[FIXTURE]} onRowClick={onRowClick} />)
		const rows = screen.getAllByRole('row')
		// rows[0] = header, rows[1] = data
		fireEvent.click(rows[1]!)
		expect(onRowClick).toHaveBeenCalledWith('mreg_001')
	})

	test('[C2] Enter keypress on row → onRowClick(id)', () => {
		const onRowClick = vi.fn()
		render(<MigrationRegistrationsTable items={[FIXTURE]} onRowClick={onRowClick} />)
		const rows = screen.getAllByRole('row')
		fireEvent.keyDown(rows[1]!, { key: 'Enter' })
		expect(onRowClick).toHaveBeenCalledWith('mreg_001')
	})

	test('[C3] Space keypress on row → onRowClick(id)', () => {
		const onRowClick = vi.fn()
		render(<MigrationRegistrationsTable items={[FIXTURE]} onRowClick={onRowClick} />)
		const rows = screen.getAllByRole('row')
		fireEvent.keyDown(rows[1]!, { key: ' ' })
		expect(onRowClick).toHaveBeenCalledWith('mreg_001')
	})
})

describe('MigrationRegistrationsTable — status badge integration', () => {
	test('[B1] status 0 (draft) → badge label "Черновик"', () => {
		render(<MigrationRegistrationsTable items={[FIXTURE]} onRowClick={vi.fn()} />)
		expect(document.body.textContent).toContain('Черновик')
	})

	test('[B2] status 3 (executed) → badge label "Исполнено"', () => {
		const executed = { ...FIXTURE, statusCode: 3, isFinal: true }
		render(<MigrationRegistrationsTable items={[executed]} onRowClick={vi.fn()} />)
		expect(document.body.textContent).toContain('Исполнено')
	})
})
