import type { Bar } from '../../../shared/types'

/** A tiny trend line for a dashboard card: no axes or hover (the card
 * opens the full chart), colored by whether the period ended up or down. */
export function Sparkline({ bars, width = 120, height = 36 }: { bars: Bar[]; width?: number; height?: number }) {
  if (bars.length < 2) return <div className="sparkline-empty" style={{ width, height }} />

  const closes = bars.map((b) => b.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const pad = 2
  const x = (i: number) => (i / (closes.length - 1)) * width
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2)
  const points = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ')
  const trend = closes[closes.length - 1] >= closes[0] ? 'up' : 'down'

  return (
    <svg className={`sparkline ${trend}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}
