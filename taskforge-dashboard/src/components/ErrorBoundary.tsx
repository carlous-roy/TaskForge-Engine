import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keeps a rendering error from unmounting the whole page; the visitor gets a message and a reload. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Console render failed', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h1>The console hit an error</h1>
          <p className="mono">{this.state.error.message}</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
