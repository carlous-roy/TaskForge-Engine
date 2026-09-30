import { useCallback, useEffect, useRef, useState } from 'react';
import { api, applyPoll } from './api.js';
import { presetFor, REPORT_TYPES, STATUSES } from './presets.js';

/** Poll every 5 s: 12 list requests a minute, a fifth of the API's per-client limit. */
const POLL_INTERVAL_MS = 5000;

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return <div className={`toast ${type || ''}`}>{message}</div>;
}

function Stat({ label, value, color }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: color || 'var(--text)' }}>{value}</div>
    </div>
  );
}

function SubmitForm({ onSubmit }) {
  const [type, setType] = useState('SALES_SUMMARY');
  const [params, setParams] = useState(JSON.stringify(presetFor('SALES_SUMMARY'), null, 0));
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleType = (t) => {
    setType(t);
    setParams(JSON.stringify(presetFor(t), null, 0));
  };

  const handleSubmit = async () => {
    let parsed;
    try {
      parsed = JSON.parse(params);
    } catch (e) {
      onSubmit(null, 'Parameters must be a JSON object: ' + e.message);
      return;
    }
    setSubmitting(true);
    try {
      const body = { type, parameters: parsed };
      if (key.trim()) body.idempotencyKey = key.trim();
      await onSubmit(body);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="form-group">
        <label className="form-label" htmlFor="type">Report type</label>
        <select id="type" className="form-select" value={type} onChange={(e) => handleType(e.target.value)}>
          {REPORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="params">Parameters (JSON)</label>
        <textarea id="params" className="form-textarea" value={params} onChange={(e) => setParams(e.target.value)} spellCheck="false" />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="key">Idempotency key (optional)</label>
        <input id="key" className="form-select" value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. order-2026-09-18-01" maxLength={128} />
      </div>
      <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
        {submitting ? 'Submitting...' : 'Generate report'}
      </button>
    </div>
  );
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function StatusCell({ report, now }) {
  if (report.status === 'RETRY_SCHEDULED' && report.nextAttemptAt) {
    const seconds = Math.max(0, Math.round((new Date(report.nextAttemptAt).getTime() - now) / 1000));
    return <span className={`badge badge-${report.status}`} title={report.errorMessage || ''}>RETRY in {seconds}s</span>;
  }
  return <span className={`badge badge-${report.status}`} title={report.errorMessage || ''}>{report.status}</span>;
}

export default function App() {
  const [state, setState] = useState({ reports: [], health: null, error: null, pausedUntil: null });
  const [filter, setFilter] = useState('ALL');
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;

  const showToast = useCallback((message, type) => setToast({ message, type, key: Date.now() }), []);
  const closeToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    if (current.pausedUntil && Date.now() < current.pausedUntil) return;
    const [reports, health] = await Promise.allSettled([api.listReports(), api.getHealth()]);
    const healthValue = health.status === 'fulfilled' ? health.value : { status: 'UNREACHABLE', detail: health.reason.message };
    if (reports.status === 'fulfilled') {
      setState((prev) => applyPoll(prev, { reports: reports.value, health: healthValue }));
    } else {
      setState((prev) => applyPoll(prev, { health: healthValue, error: reports.reason }));
    }
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, POLL_INTERVAL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  const handleSubmit = async (body, clientError) => {
    if (clientError) {
      showToast(clientError, 'error');
      return;
    }
    try {
      const r = await api.submit(body);
      showToast(`Report accepted: ${r.correlationId}`);
      refresh();
    } catch (e) {
      const detail = e.details && e.details.length ? ` (${e.details[0]})` : '';
      if (e.status === 409 && e.details && e.details.length) {
        showToast(`Duplicate: ${e.details[0]}`, 'error');
      } else {
        showToast(`Rejected (${e.status || 'network'}): ${e.message}${detail}`, 'error');
      }
    }
  };

  const reports = Array.isArray(state.reports) ? state.reports : [];
  const completed = reports.filter((r) => r.status === 'COMPLETED').length;
  const failed = reports.filter((r) => r.status === 'FAILED').length;
  const pending = reports.filter((r) => ['ACCEPTED', 'QUEUED', 'PROCESSING', 'RETRY_SCHEDULED'].includes(r.status)).length;
  const filtered = filter === 'ALL' ? reports : reports.filter((r) => r.status === filter);
  const health = state.health;
  const healthStatus = health ? health.status : 'LOADING';
  const healthColor = healthStatus === 'UP' ? 'var(--green)' : healthStatus === 'LOADING' ? 'var(--text-muted)' : '#ef4444';
  const pausedSeconds = state.pausedUntil ? Math.max(0, Math.ceil((state.pausedUntil - now) / 1000)) : 0;

  return (
    <div className="app">
      <nav className="nav">
        <div className="logo">
          <div className="logo-mark">T</div>
          <div className="logo-text">Task<span className="gradient-text">Forge</span></div>
        </div>
        <div className="nav-status">
          <div className="pulse-dot" style={{ background: healthColor }}></div>
          <span className="mono" style={{ fontSize: 11 }}>
            {healthStatus} · Queue: {health && health.queueDepth != null ? health.queueDepth : '—'}
          </span>
        </div>
      </nav>

      <main className="main">
        {state.error && (
          <div className="banner" role="alert">
            Could not refresh the report list: {state.error}
            {pausedSeconds > 0 ? ` Polling resumes in ${pausedSeconds}s.` : ' Showing the last known state.'}
          </div>
        )}

        <div className="stats fade-in">
          <Stat label="Total reports" value={reports.length} />
          <Stat label="Completed" value={completed} color="var(--green)" />
          <Stat label="Failed" value={failed} color="#ef4444" />
          <Stat label="In progress" value={pending} color="var(--amber)" />
        </div>

        <div className="content-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card fade-in">
              <div className="card-header"><div className="card-title">Generate report</div></div>
              <div className="card-body"><SubmitForm onSubmit={handleSubmit} /></div>
            </div>
            <div className="card fade-in">
              <div className="card-header"><div className="card-title">Service health</div></div>
              <div className="card-body" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                <div className="mono" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>api: <span style={{ color: healthColor }}>{healthStatus}</span>{health && health.detail ? ` (${health.detail})` : ''}</div>
                  <div>queue: <span style={{ color: 'var(--text)' }}>{health && health.queueDepth != null ? health.queueDepth : '—'}</span> waiting</div>
                  <div>dead-letter: <span style={{ color: health && health.deadLetterDepth > 0 ? '#ef4444' : 'var(--text)' }}>{health && health.deadLetterDepth != null ? health.deadLetterDepth : '—'}</span> messages</div>
                  <div>refresh: every {POLL_INTERVAL_MS / 1000}s</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card fade-in">
            <div className="card-header">
              <div className="card-title">Reports ({filtered.length})</div>
              <button className="btn btn-sm btn-ghost" onClick={refresh}>Refresh</button>
            </div>
            <div className="filters">
              {STATUSES.map((f) => (
                <button key={f} className={`btn btn-sm btn-ghost ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <div className="empty">No reports{filter !== 'ALL' ? ` with status ${filter}` : ' yet. Submit one from the left panel.'}</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Correlation</th><th>Type</th><th>Status</th><th>Attempts</th><th>Created</th><th>Duration</th><th>File</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id}>
                        <td><span className="mono" style={{ fontSize: 11, color: 'var(--orange)' }} title={r.id}>{r.correlationId}</span></td>
                        <td><span className={`type-badge type-${r.type}`}>{r.type}</span></td>
                        <td><StatusCell report={r} now={now} /></td>
                        <td><span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.attemptCount}/{r.maxAttempts}</span></td>
                        <td><span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatTime(r.createdAt)}</span></td>
                        <td><span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.executionTimeMs > 0 ? r.executionTimeMs + ' ms' : '—'}</span></td>
                        <td>
                          {r.status === 'COMPLETED' && r.downloadUrl ? (
                            <a href={r.downloadUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-ghost" style={{ textDecoration: 'none', color: 'var(--green)' }}>CSV</a>
                          ) : r.errorMessage ? (
                            <span className="mono" style={{ fontSize: 10, color: '#ef4444' }} title={r.errorMessage}>error</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>{'—'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="footer">
        <span>TaskForge · report jobs on SQS, DynamoDB and S3</span>
        <a href="https://github.com/carlous-roy/TaskForge-Engine" target="_blank" rel="noopener noreferrer">Source</a>
      </footer>

      {toast && <Toast key={toast.key} message={toast.message} type={toast.type} onClose={closeToast} />}
    </div>
  );
}
