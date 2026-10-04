import { memo } from 'react'

export interface Series {
  name: string
  color: string
  values: number[]
}

interface Props {
  series: Series[]
  /** Points drawn, from the end of each series. */
  window: number
  height?: number
  caption: string
}

const WIDTH = 300

/** Several series on one scale, newest at the right, as a small SVG that stretches to its box. */
function Sparkline({ series, window, height = 44, caption }: Props) {
  const max = Math.max(1, ...series.flatMap((s) => s.values.slice(-window)))
  const paths = series.map((s) => {
    const values = s.values.slice(-window)
    if (values.length < 2) return { ...s, d: '' }
    const step = WIDTH / (window - 1)
    const offset = window - values.length
    const d = values
      .map((v, i) => {
        const x = ((offset + i) * step).toFixed(1)
        const y = (height - 2 - (v / max) * (height - 6)).toFixed(1)
        return `${i === 0 ? 'M' : 'L'}${x} ${y}`
      })
      .join(' ')
    return { ...s, d }
  })
  const last = series.map((s) => s.values[s.values.length - 1] ?? 0)

  return (
    <figure className="sparkline">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}: ${series.map((s, i) => `${s.name} ${last[i]}`).join(', ')}`}
      >
        <line x1="0" y1={height - 2} x2={WIDTH} y2={height - 2} className="baseline" />
        {paths.map((p) => (
          <path key={p.name} d={p.d} fill="none" stroke={p.color} strokeWidth="1.5" />
        ))}
      </svg>
      <figcaption>
        {series.map((s, i) => (
          <span key={s.name}>
            <i style={{ background: s.color }} aria-hidden="true" />
            {s.name} <b className="num">{last[i]}</b>
          </span>
        ))}
        <span className="muted">peak {max}</span>
      </figcaption>
    </figure>
  )
}

export default memo(Sparkline)
