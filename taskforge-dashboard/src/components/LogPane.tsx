import { memo, useEffect, useRef, useState } from 'react'
import type { LogLevel, LogLine } from '../sim/types.ts'
import { logClock } from '../lib/format.ts'

interface Props {
  lines: LogLine[]
  epochOffset: number
  /** The correlation id to show lines for; empty shows everything. */
  filter: string
  onFilter: (filter: string) => void
  onSelect: (correlationId: string | null) => void
  shown?: number
  title?: string
  emptyText?: string
}

const LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR']

/** The processes' log lines, one pane for all of them, followed as they arrive. */
export default function LogPane({
  lines,
  epochOffset,
  filter,
  onFilter,
  onSelect,
  shown = 400,
  title = 'Log',
  emptyText = 'No lines match.',
}: Props) {
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set(LEVELS))
  const [follow, setFollow] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  const needle = filter.trim().toLowerCase()
  const visible = lines.filter(
    (l) =>
      levels.has(l.level) &&
      (needle === '' ||
        (l.cid !== null && l.cid.toLowerCase().includes(needle)) ||
        l.message.toLowerCase().includes(needle))
  )
  const tail = visible.slice(-shown)
  const lastSeq = tail[tail.length - 1]?.seq

  useEffect(() => {
    const el = bodyRef.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [lastSeq, follow, needle])

  return (
    <div className="panel log">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="small muted num">
          {visible.length === lines.length ? lines.length : `${visible.length} of ${lines.length}`}
        </span>
        <span className="spacer" />
        <input
          className="input mono log-filter"
          placeholder="correlation id or text"
          aria-label="Filter log lines"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          spellCheck={false}
        />
        {filter && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onFilter('')}>
            Clear
          </button>
        )}
        <div className="segmented" role="group" aria-label="Levels">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`level-${level}`}
              aria-pressed={levels.has(level)}
              onClick={() => {
                const next = new Set(levels)
                if (next.has(level)) next.delete(level)
                else next.add(level)
                setLevels(next)
              }}
            >
              {level}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn-sm ${follow ? 'selected' : ''}`}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
          title="Keep the newest line in view"
        >
          Follow
        </button>
      </div>
      <div
        className="log-body mono"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
          if (!atBottom && follow) setFollow(false)
        }}
      >
        {tail.map((line) => (
          <Line key={line.seq} line={line} epochOffset={epochOffset} onSelect={onSelect} />
        ))}
        {tail.length === 0 && (
          <p className="small muted">{lines.length === 0 ? emptyText : 'No lines match.'}</p>
        )}
      </div>
    </div>
  )
}

interface LineProps {
  line: LogLine
  epochOffset: number
  onSelect: (correlationId: string | null) => void
}

const Line = memo(function Line({ line, epochOffset, onSelect }: LineProps) {
  return (
    <div className={`line level-${line.level}`}>
      <span className="t">{logClock(line.t + epochOffset)}</span>
      <span className="lvl">{line.level.padEnd(5)}</span>
      <span className="src">[{line.source}]</span>
      {line.cid !== null ? (
        <button
          type="button"
          className="cid"
          onClick={() => onSelect(line.cid)}
          title="Filter on this id"
        >
          [{line.cid}]
        </button>
      ) : (
        <span className="cid empty">[]</span>
      )}
      <span className="msg">{line.message}</span>
    </div>
  )
})
