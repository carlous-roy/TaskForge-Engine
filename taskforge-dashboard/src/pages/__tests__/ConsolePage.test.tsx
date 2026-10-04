// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ConsolePage from '../ConsolePage.tsx'

describe('ConsolePage', () => {
  it('renders the console and lets a visitor break things', async () => {
    render(<ConsolePage />)
    // Pause first so the assertions below are not racing the clock.
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('heading', { name: 'worker-1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Step 1 s' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send 70 at once/ }))
    })
    expect(screen.getByText(/rejected with 429/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Permanent' }))
    expect(screen.getByRole('status')).toHaveTextContent('parameters the worker rejects')

    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' })[0] as HTMLElement)
    const lane = screen.getByRole('heading', { name: 'worker-1' }).closest('.lane') as HTMLElement
    expect(within(lane).getByText('dead')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Step 1 s' }))
    const jobs = screen.getByRole('heading', { name: 'Jobs' }).closest('.panel') as HTMLElement
    expect(within(jobs).getAllByRole('row').length).toBeGreaterThan(10)
  })

  it('filters the log when a correlation id is chosen', async () => {
    render(<ConsolePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    })
    const deck = screen
      .getByRole('heading', { name: 'Submit a report' })
      .closest('.panel') as HTMLElement
    const outcome = within(deck)
      .getByText(/202 Accepted/)
      .closest('.outcome') as HTMLElement
    const cid = within(outcome).getByRole('button').textContent ?? ''
    fireEvent.click(within(outcome).getByRole('button'))
    expect(screen.getByLabelText('Filter log lines')).toHaveValue(cid)
    const log = screen.getByRole('heading', { name: 'Log' }).closest('.panel') as HTMLElement
    expect(within(log).getAllByText(`[${cid}]`).length).toBeGreaterThan(0)
  })
})
