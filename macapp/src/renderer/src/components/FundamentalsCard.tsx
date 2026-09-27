import type { Fundamentals } from '../protocol'

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
        <div>P/E {fmt(fundamentals.pe_ratio)}</div>
        <div>PEG {fmt(fundamentals.peg_ratio)}</div>
        <div>Profit margin {fmt(fundamentals.profit_margin != null ? fundamentals.profit_margin * 100 : null, '%')}</div>
        <div>Op. margin {fmt(fundamentals.operating_margin != null ? fundamentals.operating_margin * 100 : null, '%')}</div>
        <div>ROE {fmt(fundamentals.roe != null ? fundamentals.roe * 100 : null, '%')}</div>
        <div>EPS {fmt(fundamentals.eps)}</div>
        <div>Revenue growth {fmt(fundamentals.revenue_growth_yoy != null ? fundamentals.revenue_growth_yoy * 100 : null, '%')}</div>
        <div>Earnings growth {fmt(fundamentals.earnings_growth_yoy != null ? fundamentals.earnings_growth_yoy * 100 : null, '%')}</div>
      </div>
    </div>
  )
}
