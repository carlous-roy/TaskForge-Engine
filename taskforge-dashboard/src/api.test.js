import { describe, expect, it } from 'vitest';
import { ApiError, applyPoll, parseResponse } from './api.js';
import { daysAgo, isoDate, presetFor } from './presets.js';

function response(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('parseResponse', () => {
  it('returns the body of a successful response', async () => {
    await expect(parseResponse(response(200, [{ id: 'a' }]))).resolves.toEqual([{ id: 'a' }]);
  });

  it('turns a 429 into an ApiError carrying Retry-After instead of data', async () => {
    const r = response(429, { message: 'Rate limit exceeded', correlationId: 'abc' }, { 'retry-after': '17' });
    const error = await parseResponse(r).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(17);
    expect(error.message).toBe('Rate limit exceeded');
    expect(error.correlationId).toBe('abc');
  });

  it('copes with error responses that are not JSON', async () => {
    const r = new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const error = await parseResponse(r).catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.message).toBe('HTTP 502');
    expect(error.retryAfterSeconds).toBeNull();
  });
});

describe('applyPoll', () => {
  const previous = { reports: [{ id: 'kept' }], health: { status: 'UP' }, error: null, pausedUntil: null };

  it('replaces the list and clears errors on success', () => {
    const next = applyPoll(previous, { reports: [{ id: 'new' }], health: { status: 'UP', queueDepth: 1 } });
    expect(next.reports).toEqual([{ id: 'new' }]);
    expect(next.error).toBeNull();
    expect(next.pausedUntil).toBeNull();
  });

  it('keeps the previous list when the refresh fails', () => {
    const next = applyPoll(previous, { error: new ApiError(500, 'boom'), now: 1000 });
    expect(next.reports).toEqual([{ id: 'kept' }]);
    expect(next.error).toBe('boom');
    expect(next.pausedUntil).toBeNull();
  });

  it('pauses polling for Retry-After seconds on a 429', () => {
    const next = applyPoll(previous, { error: new ApiError(429, 'slow down', { retryAfterSeconds: 30 }), now: 1000 });
    expect(next.reports).toEqual([{ id: 'kept' }]);
    expect(next.pausedUntil).toBe(31000);
  });

  it('never stores a non-array as the report list', () => {
    const next = applyPoll(previous, { error: new ApiError(429, 'x'), now: 0 });
    expect(Array.isArray(next.reports)).toBe(true);
  });
});

describe('presets', () => {
  const today = new Date('2026-09-18T15:00:00Z');

  it('derive their date windows from today', () => {
    expect(isoDate(today)).toBe('2026-09-18');
    expect(daysAgo(30, today)).toBe('2026-08-19');
    expect(presetFor('SALES_SUMMARY', today)).toEqual({ dateFrom: '2026-08-19', dateTo: '2026-09-18', region: 'North' });
    expect(presetFor('USER_ACTIVITY', today)).toEqual({ dateFrom: '2026-09-11', dateTo: '2026-09-18' });
    expect(presetFor('INVENTORY_SNAPSHOT', today)).toEqual({ lowStockThreshold: '15' });
  });
});
