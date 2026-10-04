// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import JobsTable from '../JobsTable.tsx'
import type { Job } from '../../sim/types.ts'

function job(overrides: Partial<Job>): Job {
  return {
    id: '6ae6def5-0000-4000-8000-000000000000',
    type: 'SALES_SUMMARY',
    status: 'QUEUED',
    parameters: {},
    correlationId: 'abc123def456',
    idempotencyKey: null,
    errorMessage: null,
    attemptCount: 0,
    maxAttempts: 3,
    version: 0,
    lockedBy: null,
    fileKey: null,
    downloadUrl: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
    executionTimeMs: 0,
    ...overrides,
  }
}

const EPOCH = Date.UTC(2026, 8, 18, 12)

describe('JobsTable', () => {
  it('shows a retry countdown, the worker and the file, and filters by status', () => {
    const jobs = [
      job({
        id: 'a',
        correlationId: 'aaa',
        status: 'RETRY_SCHEDULED',
        nextAttemptAt: 7_400,
        attemptCount: 1,
        errorMessage: 'Read timed out',
      }),
      job({
        id: 'b',
        correlationId: 'bbb',
        status: 'PROCESSING',
        lockedBy: 'worker-2',
        attemptCount: 1,
      }),
      job({
        id: 'c',
        correlationId: 'ccc',
        status: 'COMPLETED',
        fileKey: 'reports/sales_summary/c.csv',
        executionTimeMs: 1_234,
        attemptCount: 1,
      }),
    ]
    const onFilter = vi.fn()
    const onSelect = vi.fn()
    render(
      <JobsTable
        jobs={jobs}
        now={EPOCH + 3_000}
        epochOffset={EPOCH}
        selected={null}
        onSelect={onSelect}
        filter="ALL"
        onFilter={onFilter}
      />
    )
    expect(screen.getByText('Retry in 5 s')).toBeInTheDocument()
    expect(screen.getByText('worker-2')).toBeInTheDocument()
    expect(screen.getByText('c.csv')).toBeInTheDocument()
    expect(screen.getByText('1.2 s')).toBeInTheDocument()
    fireEvent.click(screen.getByText('aaa'))
    expect(onSelect).toHaveBeenCalledWith('aaa')
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }))
    expect(onFilter).toHaveBeenCalledWith('COMPLETED')
  })

  it('links completed rows to the download in the service edition', () => {
    render(
      <JobsTable
        jobs={[job({ id: 'c', status: 'COMPLETED', attemptCount: 1 })]}
        now={EPOCH}
        epochOffset={0}
        selected={null}
        onSelect={() => {}}
        filter="ALL"
        onFilter={() => {}}
        downloadUrl={(j) => `/api/v1/reports/${j.id}/download`}
      />
    )
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      '/api/v1/reports/c/download'
    )
  })

  it('says when a filter hides everything', () => {
    render(
      <JobsTable
        jobs={[job({})]}
        now={EPOCH}
        epochOffset={EPOCH}
        selected={null}
        onSelect={() => {}}
        filter="FAILED"
        onFilter={() => {}}
      />
    )
    expect(screen.getByText('No jobs with status FAILED.')).toBeInTheDocument()
  })
})
