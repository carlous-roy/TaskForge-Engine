// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LogPane from '../LogPane.tsx'
import type { LogLine } from '../../sim/types.ts'

const EPOCH = Date.UTC(2026, 8, 18, 12)
const LINES: LogLine[] = [
  {
    seq: 1,
    t: 0,
    level: 'INFO',
    source: 'api',
    cid: 'aaa111',
    message: 'Report submitted: SALES_SUMMARY one',
  },
  {
    seq: 2,
    t: 500,
    level: 'WARN',
    source: 'worker-1',
    cid: 'bbb222',
    message: 'Attempt 1 of 3 failed',
  },
  { seq: 3, t: 900, level: 'ERROR', source: 'dlq', cid: 'bbb222', message: 'Dead-lettered' },
  {
    seq: 4,
    t: 1_000,
    level: 'INFO',
    source: 'sqs',
    cid: null,
    message: 'Visibility timeout expired',
  },
]

describe('LogPane', () => {
  it('filters by correlation id and by level', () => {
    const onFilter = vi.fn()
    const onSelect = vi.fn()
    const { rerender } = render(
      <LogPane
        lines={LINES}
        epochOffset={EPOCH}
        filter=""
        onFilter={onFilter}
        onSelect={onSelect}
      />
    )
    expect(screen.getByText('12:00:00.000')).toBeInTheDocument()
    expect(screen.getAllByText(/\[bbb222\]/)).toHaveLength(2)
    fireEvent.click(screen.getAllByText(/\[bbb222\]/)[0] as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('bbb222')

    rerender(
      <LogPane
        lines={LINES}
        epochOffset={EPOCH}
        filter="bbb222"
        onFilter={onFilter}
        onSelect={onSelect}
      />
    )
    expect(screen.queryByText(/Report submitted/)).not.toBeInTheDocument()
    expect(screen.getByText('2 of 4')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'WARN' }))
    expect(screen.queryByText('Attempt 1 of 3 failed')).not.toBeInTheDocument()
    expect(screen.getByText('Dead-lettered')).toBeInTheDocument()
  })

  it('shows the empty text before anything happened', () => {
    render(
      <LogPane
        lines={[]}
        epochOffset={0}
        filter=""
        onFilter={() => {}}
        onSelect={() => {}}
        title="Activity"
        emptyText="Nothing yet."
      />
    )
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument()
  })
})
