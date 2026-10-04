// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SubmitForm, { type Outcome, type SubmitRequestBody } from '../SubmitForm.tsx'

const TODAY = Date.UTC(2026, 8, 18, 12)

describe('SubmitForm', () => {
  it('fills the preset for the chosen type and sends compact parameters with the key', async () => {
    const bodies: SubmitRequestBody[] = []
    const onSubmit = vi.fn(async (body: SubmitRequestBody): Promise<Outcome> => {
      bodies.push(body)
      return { tone: 'green', text: '202 Accepted', correlationId: 'cid-1' }
    })
    const onSelect = vi.fn()
    render(<SubmitForm todayMs={TODAY} onSubmit={onSubmit} onSelect={onSelect} keyHint="hint" />)

    expect(screen.getByLabelText('dateFrom')).toHaveValue('2026-08-19')
    fireEvent.click(screen.getByRole('button', { name: 'Inventory snapshot' }))
    expect(screen.getByLabelText('lowStockThreshold')).toHaveValue('15')
    expect(screen.getByLabelText('warehouse')).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByLabelText(/Idempotency key/)).toHaveValue('order-2026-09-18-01')
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => expect(screen.getByText('202 Accepted')).toBeInTheDocument())
    expect(bodies).toEqual([
      {
        type: 'INVENTORY_SNAPSHOT',
        parameters: { lowStockThreshold: '15' },
        idempotencyKey: 'order-2026-09-18-01',
      },
    ])

    fireEvent.click(screen.getByText('cid-1'))
    expect(onSelect).toHaveBeenCalledWith('cid-1')

    fireEvent.click(screen.getByRole('button', { name: 'Send the same key again' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual(bodies[0])
  })

  it('lists the details of a rejected request', async () => {
    const onSubmit = vi.fn(async (): Promise<Outcome> => ({
      tone: 'violet',
      text: '400 Bad Request',
      details: ["parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'yesterday'"],
    }))
    render(<SubmitForm todayMs={TODAY} onSubmit={onSubmit} keyHint="hint" />)
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => expect(screen.getByText('400 Bad Request')).toBeInTheDocument())
    expect(screen.getByText(/got 'yesterday'/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Send the same key again' })
    ).not.toBeInTheDocument()
  })
})
