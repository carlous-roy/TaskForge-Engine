// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PipelineBoard from '../PipelineBoard.tsx'
import { Simulation } from '../../sim/index.ts'
import type { Response } from '../../hooks/useSimulation.ts'

const SALES = { type: 'SALES_SUMMARY' as const, parameters: { region: 'North' } }

function board(sim: Simulation, responses: Response[] = [], onSelect = vi.fn()) {
  const handlers = { onKill: vi.fn(), onFreeze: vi.fn(), onDrain: vi.fn(), onRestart: vi.fn() }
  const view = render(
    <PipelineBoard
      state={sim.state()}
      config={sim.config}
      responses={responses}
      selected={null}
      onSelect={onSelect}
      {...handlers}
    />
  )
  return { ...view, handlers }
}

describe('PipelineBoard', () => {
  it('shows the queue, the lanes with their slots, and the stores', () => {
    const sim = new Simulation()
    sim.burst(5, SALES)
    sim.advance(400)
    const { handlers } = board(sim)
    expect(screen.getByRole('heading', { name: 'SQS queue' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'worker-1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'worker-2' })).toBeInTheDocument()
    expect(screen.getAllByText(/try 1/).length).toBeGreaterThan(0)
    expect(screen.getByText('No files yet')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' })[0] as HTMLElement)
    expect(handlers.onKill).toHaveBeenCalledWith('worker-1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Freeze' })[1] as HTMLElement)
    expect(handlers.onFreeze).toHaveBeenCalledWith('worker-2', 150)
  })

  it('keeps a dead worker’s jobs on its lane as held locks until the takeover', () => {
    const sim = new Simulation()
    sim.burst(2, SALES)
    sim.advance(300)
    const running = sim.state().workers.find((w) => w.slots.length > 0)
    if (!running) throw new Error('expected a worker to be running a job')
    sim.killWorker(running.id)
    sim.advance(1_000)
    board(sim)
    expect(screen.getByText('dead')).toBeInTheDocument()
    expect(screen.getAllByText('lock held').length).toBe(running.slots.length)
    expect(screen.getAllByText(/visible in 1\d\d s/).length).toBe(running.slots.length)
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
  })

  it('shows the armed fault and, later, the dead-lettered job', () => {
    const sim = new Simulation()
    sim.arm('transient')
    const { rerender } = board(sim)
    expect(screen.getByRole('status')).toHaveTextContent('Poison armed')
    sim.submit(SALES)
    sim.advance(400_000)
    const state = sim.state()
    expect(state.stats.deadLettered).toBe(1)
    rerender(
      <PipelineBoard
        state={state}
        config={sim.config}
        responses={[]}
        selected={null}
        onSelect={() => {}}
        onKill={() => {}}
        onFreeze={() => {}}
        onDrain={() => {}}
        onRestart={() => {}}
      />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing dead-lettered')).not.toBeInTheDocument()
    const dlq = screen.getByRole('heading', { name: 'Dead-letter queue' }).closest('.node')
    expect(dlq).toHaveClass('has-items')
  })

  it('shows the answers to the visitor’s requests and the rate window', () => {
    const sim = new Simulation()
    const responses: Response[] = [
      { seq: 1, t: 0, status: 202, correlationId: 'aaa', summary: '202 Accepted: one' },
      { seq: 2, t: 0, status: 429, correlationId: 'bbb', summary: '429 Too Many Requests' },
    ]
    const onSelect = vi.fn()
    board(sim, responses, onSelect)
    expect(screen.getByText('429 Too Many Requests')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '202 Accepted: one' }))
    expect(onSelect).toHaveBeenCalledWith('aaa')
    expect(screen.getByText(/0 requests this window/)).toBeInTheDocument()
  })
})
