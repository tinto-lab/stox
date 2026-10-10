import { useEffect, useRef, useState } from 'react'
import type { Bar, HistoryRange } from '../../../shared/types'
import { changeClass, fmtPrice, fmtSignedPercent } from '../format'

const HEIGHT = 260
const PAD = { top: 12, right: 60, bottom: 26, left: 4 }

/** ~4-6 round-number gridline values spanning [min, max]. */
function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min || Math.abs(max) || 1
  const rough = span / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough
  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(v)
  return ticks
}

function dateLabel(iso: string, range: HistoryRange): string {
  const d = new Date(`${iso}T00:00:00`)
  if (range === '5Y') return String(d.getFullYear())
  if (range === '1Y') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Single-series close-price line with a hover crosshair + tooltip. Colored
 * by the period's direction; the title/range tabs above it name the series,
 * so there's no legend. */
export function PriceChart({
  bars,
  range,
  onPick
}: {
  bars: Bar[]
  range: HistoryRange
  /** Clicking a point reports the index of the bar under the cursor. */
  onPick?: (index: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The wrapper stays mounted either way, so the ResizeObserver keeps watching it.
  if (bars.length < 2) {
    return (
      <div ref={wrapRef} className="price-chart">
        <div className="chart-empty" style={{ height: HEIGHT }}>
          No price history for this range.
        </div>
      </div>
    )
  }

  const closes = bars.map((b) => b.close)
  const lo = Math.min(...closes)
  const hi = Math.max(...closes)
  const margin = (hi - lo) * 0.08 || hi * 0.01 || 1
  const ticks = niceTicks(lo - margin, hi + margin)
  const yMin = Math.min(ticks[0], lo - margin)
  const yMax = Math.max(ticks[ticks.length - 1], hi + margin)

  const plotW = width - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (i / (bars.length - 1)) * plotW
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH

  const line = closes.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join('')
  const area = `${line}L${x(bars.length - 1).toFixed(1)},${PAD.top + plotH}L${x(0).toFixed(1)},${PAD.top + plotH}Z`
  const trend = closes[closes.length - 1] >= closes[0] ? 'up' : 'down'

  const labelCount = Math.max(2, Math.min(6, Math.floor(plotW / 110)))
  const xLabels = Array.from({ length: labelCount }, (_, k) => Math.round((k / (labelCount - 1)) * (bars.length - 1)))

  const indexAt = (e: React.MouseEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    return Math.max(0, Math.min(bars.length - 1, Math.round(ratio * (bars.length - 1))))
  }
  const onMove = (e: React.MouseEvent<SVGRectElement>): void => setHover(indexAt(e))

  const hovered = hover !== null ? bars[hover] : null
  const hoveredChange = hovered ? (hovered.close / closes[0] - 1) * 100 : 0
  const tooltipLeft = hover !== null ? Math.min(Math.max(x(hover) - 70, 0), width - PAD.right - 140) : 0

  return (
    <div ref={wrapRef} className="price-chart">
      <svg className={trend} width={width} height={HEIGHT} role="img" aria-label={`Closing price, ${range}`}>
        <defs>
          <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.14} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={PAD.left + plotW + 8} y={y(t)} dominantBaseline="middle">
              {fmtPrice(t)}
            </text>
          </g>
        ))}
        {xLabels.map((i, k) => (
          <text
            key={i}
            className="axis-label"
            x={x(i)}
            y={HEIGHT - 8}
            textAnchor={k === 0 ? 'start' : k === xLabels.length - 1 ? 'end' : 'middle'}
          >
            {dateLabel(bars[i].date, range)}
          </text>
        ))}

        <g>
          <path d={area} fill="url(#area-fill)" />
          <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
          {hover !== null && (
            <>
              <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
              <circle
                cx={x(hover)}
                cy={y(closes[hover])}
                r={4.5}
                fill="currentColor"
                stroke="var(--bg)"
                strokeWidth={2}
              />
            </>
          )}
        </g>

        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          style={onPick ? { cursor: 'pointer' } : undefined}
          onMouseMove={onMove}
          onClick={onPick && ((e) => onPick(indexAt(e)))}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hovered && (
        <div className="chart-tooltip" style={{ left: tooltipLeft }}>
          <div className="chart-tooltip-date">
            {new Date(`${hovered.date}T00:00:00`).toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            })}
          </div>
          <div className="chart-tooltip-value">{fmtPrice(hovered.close)}</div>
          <div className={changeClass(hoveredChange)}>{fmtSignedPercent(hoveredChange)} over period</div>
        </div>
      )}
    </div>
  )
}
