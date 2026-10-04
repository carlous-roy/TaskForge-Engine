import type { ReactNode } from 'react'
import { count } from '../lib/format.ts'

export type Tone = 'amber' | 'green' | 'red' | 'cyan' | 'violet' | 'grey' | 'plain'

export interface Tile {
  label: string
  value: number
  tone?: Tone
  /** A second line under the number. */
  sub?: string
  title?: string
}

interface Props {
  tiles: Tile[]
  /** The chart at the end of the strip. */
  children?: ReactNode
}

/** The row of counters across the top of the console. */
export default function StatStrip({ tiles, children }: Props) {
  return (
    <section className="stats" aria-label="Counters">
      {tiles.map((tile) => (
        <div key={tile.label} className={`tile tone-${tile.tone ?? 'plain'}`} title={tile.title}>
          <span className="tile-label">{tile.label}</span>
          <span className="tile-value num">{count(tile.value)}</span>
          {tile.sub && <span className="tile-sub">{tile.sub}</span>}
        </div>
      ))}
      {children && <div className="tile tile-chart">{children}</div>}
    </section>
  )
}
