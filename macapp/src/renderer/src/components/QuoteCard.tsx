import type { Quote } from '../protocol'

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`
  return volume.toFixed(0)
}

export function QuoteCard({ quotes, missing = [] }: { quotes: Quote[]; missing?: string[] }) {
  if (!quotes.length && !missing.length) return null
  return (
    <div className="card">
      <table className="quote-table">
        <thead>
          <tr>
            <th>ticker</th>
            <th>price</th>
            <th>change</th>
            <th>range</th>
            <th>volume</th>
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.code}>
              <td>{q.code}</td>
              <td>{q.price.toFixed(2)}</td>
              <td className={q.change >= 0 ? 'up' : 'down'}>
                {q.change >= 0 ? '▲' : '▼'} {q.change.toFixed(2)} ({q.percent.toFixed(2)}%)
              </td>
              <td>
                {q.low.toFixed(2)} – {q.high.toFixed(2)}
              </td>
              <td>{formatVolume(q.volume)}</td>
            </tr>
          ))}
          {missing.map((code) => (
            <tr key={code} className="missing">
              <td>{code}</td>
              <td colSpan={4}>no data</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
