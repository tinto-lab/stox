import { useEffect, useState } from 'react'
import { displaySymbol } from '../../../shared/symbols'
import type { Bar, Fundamentals, HistoryRange, Quote, WatchlistEntry } from '../../../shared/types'
import {
  changeClass,
  fmtChange,
  fmtCompact,
  fmtNumber,
  fmtPercent,
  fmtPrice,
  fmtSignedPercent,
  fmtTime
} from '../format'
import { PriceChart } from './PriceChart'

const RANGES: HistoryRange[] = ['1M', '3M', '6M', '1Y', '5Y']

type Row = [label: string, value: string]

/** Rows Yahoo has no data for are dropped, and a section with none left is
 * skipped -- a crypto pair or ETF would otherwise be a wall of dashes. */
function StatTable({ title, rows }: { title: string; rows: Row[] }) {
  const known = rows.filter(([, value]) => !/^[—\s–]*$/.test(value))
  if (known.length === 0) return null
  return (
    <section className="stat-section">
      <h3>{title}</h3>
      <dl>
        {known.map(([label, value]) => (
          <div key={label} className="stat-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function recommendationLabel(key: string | null): string {
  if (!key || key === 'none') return '—'
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function FundamentalsSections({ f, price }: { f: Fundamentals; price: number | null }) {
  const upside = f.targetMeanPrice !== null && price ? f.targetMeanPrice / price - 1 : null
  return (
    <div className="stat-sections">
      <StatTable
        title="Valuation"
        rows={[
          ['Market cap', fmtCompact(f.marketCap)],
          ['Enterprise value', fmtCompact(f.enterpriseValue)],
          ['P/E (TTM)', fmtNumber(f.trailingPE)],
          ['Forward P/E', fmtNumber(f.forwardPE)],
          ['PEG', fmtNumber(f.pegRatio)],
          ['Price / book', fmtNumber(f.priceToBook)],
          ['Price / sales', fmtNumber(f.priceToSales)]
        ]}
      />
      <StatTable
        title="Profitability"
        rows={[
          ['Gross margin', fmtPercent(f.grossMargin)],
          ['Operating margin', fmtPercent(f.operatingMargin)],
          ['Profit margin', fmtPercent(f.profitMargin)],
          ['Return on equity', fmtPercent(f.roe)],
          ['Return on assets', fmtPercent(f.roa)],
          ['EPS (TTM)', fmtNumber(f.eps)],
          ['Forward EPS', fmtNumber(f.forwardEps)]
        ]}
      />
      <StatTable
        title="Growth & cash flow"
        rows={[
          ['Revenue (TTM)', fmtCompact(f.revenueTtm)],
          ['Revenue growth (YoY)', fmtPercent(f.revenueGrowth)],
          ['Earnings growth (YoY)', fmtPercent(f.earningsGrowth)],
          ['EBITDA', fmtCompact(f.ebitda)],
          ['Free cash flow', fmtCompact(f.freeCashflow)]
        ]}
      />
      <StatTable
        title="Balance sheet"
        rows={[
          ['Total cash', fmtCompact(f.totalCash)],
          ['Total debt', fmtCompact(f.totalDebt)],
          // Yahoo reports debt/equity already in percent (154.5 = 1.545x).
          ['Debt / equity', f.debtToEquity === null ? '—' : `${fmtNumber(f.debtToEquity, 1)}%`],
          ['Current ratio', fmtNumber(f.currentRatio)]
        ]}
      />
      <StatTable
        title="Dividends & risk"
        rows={[
          ['Dividend yield', fmtPercent(f.dividendYield)],
          ['Payout ratio', fmtPercent(f.payoutRatio)],
          ['Beta', fmtNumber(f.beta)],
          ['52-week range', `${fmtPrice(f.fiftyTwoWeekLow)} – ${fmtPrice(f.fiftyTwoWeekHigh)}`]
        ]}
      />
      <StatTable
        title="Analysts"
        rows={[
          ['Mean target', fmtPrice(f.targetMeanPrice)],
          ['Implied upside', upside === null ? '—' : fmtSignedPercent(upside * 100)],
          ['Consensus', recommendationLabel(f.recommendation)],
          ['Analysts', f.analystCount === null ? '—' : String(f.analystCount)]
        ]}
      />
    </div>
  )
}

function About({ f }: { f: Fundamentals }) {
  const [expanded, setExpanded] = useState(false)
  const facts = [
    f.sector && f.industry ? `${f.sector} · ${f.industry}` : f.sector || f.industry,
    f.country,
    f.employees ? `${f.employees.toLocaleString('en-US')} employees` : null
  ].filter(Boolean)

  if (!f.summary && facts.length === 0) return null
  return (
    <section className="about">
      <h3>About</h3>
      {facts.length > 0 && (
        <p className="about-facts">
          {facts.join('  ·  ')}
          {f.website && (
            <>
              {'  ·  '}
              <a href={f.website} target="_blank" rel="noreferrer">
                {f.website.replace(/^https?:\/\/(www\.)?/, '')}
              </a>
            </>
          )}
        </p>
      )}
      {f.summary && (
        <>
          <p className={`about-summary ${expanded ? '' : 'clamped'}`}>{f.summary}</p>
          <button className="link-button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </>
      )}
    </section>
  )
}

export function StockDetail({
  entry,
  quote,
  quoteMissing,
  pinned,
  onBack,
  onTogglePin,
  onAnalyze
}: {
  entry: WatchlistEntry
  quote: Quote | undefined
  quoteMissing: boolean
  pinned: boolean
  onBack: () => void
  onTogglePin: (name: string) => void
  onAnalyze: () => void
}) {
  const [range, setRange] = useState<HistoryRange>('3M')
  const [bars, setBars] = useState<Bar[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null)
  const [fundamentalsError, setFundamentalsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFundamentals(null)
    setFundamentalsError(null)
    window.stox
      .fundamentals(entry.code)
      .then((f) => !cancelled && setFundamentals(f))
      .catch((e: Error) => !cancelled && setFundamentalsError(e.message))
    return () => {
      cancelled = true
    }
  }, [entry.code])

  useEffect(() => {
    let cancelled = false
    setBars(null)
    setHistoryError(null)
    window.stox
      .history(entry.code, range)
      .then((b) => !cancelled && setBars(b))
      .catch((e: Error) => !cancelled && setHistoryError(e.message))
    return () => {
      cancelled = true
    }
  }, [entry.code, range])

  const name = fundamentals?.name || entry.name
  const periodChange = bars && bars.length > 1 ? (bars[bars.length - 1].close / bars[0].close - 1) * 100 : null

  return (
    <div className="detail">
      <button className="link-button back" onClick={onBack}>
        ‹ Dashboard
      </button>

      <header className="detail-header">
        <div>
          <div className="detail-id">
            <h1>{displaySymbol(entry.code)}</h1>
            {fundamentals?.currency && <span className="badge">{fundamentals.currency}</span>}
          </div>
          <div className="detail-name">{name || ' '}</div>
        </div>
        <div className="detail-actions">
          <button onClick={onAnalyze} title="Run the multi-agent /analyze in the chat panel">
            Analyze in chat
          </button>
          <button className={pinned ? 'primary' : ''} onClick={() => onTogglePin(name)}>
            {pinned ? '★ Pinned' : '☆ Pin to dashboard'}
          </button>
        </div>
      </header>

      <div className="detail-quote">
        {quote ? (
          <>
            <span className="detail-price">{fmtPrice(quote.price)}</span>
            <span className={`detail-change ${changeClass(quote.change)}`}>
              {fmtChange(quote.change, quote.price)} ({fmtSignedPercent(quote.percent)}) today
            </span>
            {quote.timestamp && <span className="dim">as of {fmtTime(quote.timestamp)}</span>}
          </>
        ) : (
          <span className="dim">{quoteMissing ? 'No quote data for this ticker.' : 'Loading quote…'}</span>
        )}
      </div>

      <div className="card chart-card">
        <div className="chart-toolbar">
          <div className="segmented" role="tablist">
            {RANGES.map((r) => (
              <button
                key={r}
                role="tab"
                aria-selected={r === range}
                className={r === range ? 'active' : ''}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          {periodChange !== null && (
            <span className={changeClass(periodChange)}>
              {fmtSignedPercent(periodChange)} <span className="dim">over {range}</span>
            </span>
          )}
        </div>
        {historyError ? (
          <div className="chart-empty error-text">{historyError}</div>
        ) : bars === null ? (
          <div className="chart-empty">Loading…</div>
        ) : (
          <PriceChart bars={bars} range={range} />
        )}
      </div>

      {quote && (
        <div className="quote-strip">
          <div>
            <span>Open</span>
            {fmtPrice(quote.open)}
          </div>
          <div>
            <span>Prev close</span>
            {fmtPrice(quote.prevClose)}
          </div>
          <div>
            <span>Day range</span>
            {fmtPrice(quote.low)} – {fmtPrice(quote.high)}
          </div>
          <div>
            <span>Volume</span>
            {fmtCompact(quote.volume)}
          </div>
        </div>
      )}

      <h2 className="section-title">Fundamentals</h2>
      {fundamentalsError ? (
        <p className="dim">Fundamentals unavailable: {fundamentalsError}</p>
      ) : fundamentals === null ? (
        <p className="dim">Loading fundamentals…</p>
      ) : (
        <>
          <FundamentalsSections f={fundamentals} price={quote?.price ?? null} />
          <About f={fundamentals} />
          <p className="source-note">Fundamentals from Yahoo Finance · prices from EODHD</p>
        </>
      )}
    </div>
  )
}
