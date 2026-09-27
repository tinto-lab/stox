import type { Article, GeoArticle } from '../protocol'

function sentimentArrow(value: number | undefined): string {
  if (value === undefined) return '·'
  if (value > 0.1) return '▲'
  if (value < -0.1) return '▼'
  return '·'
}

export function NewsList({ articles }: { articles: Article[] }) {
  if (!articles.length) return null
  return (
    <div className="card">
      {articles.map((a) => (
        <div className="news-row" key={a.link}>
          <span className={`arrow ${(a.sentiment.polarity ?? 0) >= 0 ? 'up' : 'down'}`}>
            {sentimentArrow(a.sentiment.polarity)}
          </span>
          <span className="news-date">{a.date.slice(0, 10)}</span>
          <a className="news-title" href={a.link} target="_blank" rel="noreferrer">
            {a.title}
          </a>
        </div>
      ))}
    </div>
  )
}

export function GeoNewsList({ articles }: { articles: GeoArticle[] }) {
  if (!articles.length) return null
  return (
    <div className="card">
      {articles.map((a) => (
        <div className="news-row" key={a.link}>
          <span className={`arrow ${a.sentiment === 'negative' ? 'down' : a.sentiment === 'positive' ? 'up' : ''}`}>
            {a.sentiment === 'negative' ? '▼' : a.sentiment === 'positive' ? '▲' : '·'}
          </span>
          <span className="news-date">{a.date.slice(0, 10)}</span>
          <span className="news-country">{a.country}</span>
          <a className="news-title" href={a.link} target="_blank" rel="noreferrer">
            {a.title}
          </a>
        </div>
      ))}
    </div>
  )
}
