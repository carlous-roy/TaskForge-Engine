import { Component } from 'react';

/** Keeps a rendering error from unmounting the whole page; the user gets a message and a reload. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Dashboard render failed', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h1>The dashboard hit an error</h1>
          <p className="mono">{String(this.state.error && this.state.error.message)}</p>
          <button className="btn btn-ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
