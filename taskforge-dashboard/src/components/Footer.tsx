import { EDITION, REPO_URL } from '../edition.ts'
import type { SimConfig } from '../sim/types.ts'

interface Props {
  config: SimConfig
}

/** The constants the console runs on, and what this edition is, in one line each. */
export default function Footer({ config }: Props) {
  return (
    <footer className="foot">
      <p>
        {EDITION === 'browser'
          ? 'No server behind this page. The console drives a simulator of the TaskForge service: the same idempotency, locking, retry, visibility-timeout and rate-limit rules, with the service constants below, on a seeded clock that replays exactly.'
          : 'Served by the TaskForge API. The console polls the report list and the health endpoint every five seconds and keeps the last answer on screen when a refresh fails.'}
      </p>
      <p className="constants mono small">
        visibility {config.visibilityTimeoutS}s · attempts {config.maxAttempts} · backoff{' '}
        {config.backoffBaseS}s to {config.backoffCapS}s full jitter · drain {config.drainTimeoutS}s
        · {config.workers} workers x {config.maxConcurrent} slots · batch {config.batchSize} ·{' '}
        {config.rateLimitPerMinute} req/min ·{' '}
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          carlous-roy/TaskForge-Engine
        </a>
      </p>
    </footer>
  )
}
