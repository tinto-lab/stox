import type { Fundamentals } from '../../../shared/types'

function fmt(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(2)}${suffix}`
}

export function FundamentalsCard({ fundamentals }: { fundamentals: Fundamentals | null }) {
  if (!fundamentals) return null
  return (
    <div className="card">
      <div className="card-title">
        {fundamentals.name ?? fundamentals.code} · {fundamentals.sector ?? '—'} / {fundamentals.industry ?? '—'}
      </div>
      <div className="stat-grid">
        <div>P/E {fmt(fundamentals.trailingPE)}</div>
        <div>PEG {fmt(fundamentals.pegRatio)}</div>
        <div>Profit margin {fmt(fundamentals.profitMargin != null ? fundamentals.profitMargin * 100 : null, '%')}</div>
        <div>Op. margin {fmt(fundamentals.operatingMargin != null ? fundamentals.operatingMargin * 100 : null, '%')}</div>
        <div>ROE {fmt(fundamentals.roe != null ? fundamentals.roe * 100 : null, '%')}</div>
        <div>EPS {fmt(fundamentals.eps)}</div>
        <div>Revenue growth {fmt(fundamentals.revenueGrowth != null ? fundamentals.revenueGrowth * 100 : null, '%')}</div>
        <div>Earnings growth {fmt(fundamentals.earningsGrowth != null ? fundamentals.earningsGrowth * 100 : null, '%')}</div>
      </div>
    </div>
  )
}
