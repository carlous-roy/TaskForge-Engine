import type { ReactNode } from 'react'
import { EDITION, REPO_URL } from '../edition.ts'

interface Props {
  /** The controls at the right end of the bar: the transport in the browser edition, health in the service. */
  children?: ReactNode
}

export default function TopBar({ children }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/rc-logo.svg" alt="" width="26" height="24" className="mark" />
        <span className="wordmark">TaskForge</span>
        <span className="product">Operations console</span>
        <span className={`pill edition edition-${EDITION}`} title={EDITION_TITLE[EDITION]}>
          <span className="dot" aria-hidden="true" />
          {EDITION === 'browser' ? 'Simulated service, in this tab' : 'Live service'}
        </span>
      </div>
      <div className="bar-controls">{children}</div>
      <a className="source" href={REPO_URL} target="_blank" rel="noopener noreferrer">
        Source
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </header>
  )
}

const EDITION_TITLE = {
  browser:
    'No server behind this page: a simulator of the TaskForge service runs here, with the service rules and constants.',
  service: 'This page is served by the TaskForge API and shows its live state.',
}
