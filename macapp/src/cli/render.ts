import { stripVTControlCharacters, styleText } from 'node:util'
import type { AnalysisResult, Article, Bar, Fundamentals, GeoArticle, Quote } from '../shared/types'

/**
 * Terminal presentation: turns quotes, bars, fundamentals, news and
 * analyses into styled text. Pure functions returning strings -- shell.ts
 * owns printing. Text that comes from outside (headlines, model output) is
 * only ever styled as a whole, never parsed for markup.
 */

type Style = Parameters<typeof styleText>[0]

/** styleText that respects NO_COLOR / non-TTY output (styleText's default). */
export const style = (format: Style, text: string): string => styleText(format, text)
export const dim = (text: string): string => style('dim', text)
export const bold = (text: string): string => style('bold', text)

const width = (text: string): number => [...stripVTControlCharacters(text)].length
const padEnd = (text: string, n: number): string => text + ' '.repeat(Math.max(0, n - width(text)))
const padStart = (text: string, n: number): string => ' '.repeat(Math.max(0, n - width(text))) + text

export function terminalWidth(): number {
  return Math.min(process.stdout.columns || 100, 100)
}

/** Columns padded to their widest cell; `right` lists right-aligned columns. */
export function table(rows: string[][], { gap = 2, right = [] as number[] } = {}): string {
  const widths: number[] = []
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, width(cell))))
  return rows
    .map((row) =>
      row
        .map((cell, i) => (right.includes(i) ? padStart(cell, widths[i]) : i === row.length - 1 ? cell : padEnd(cell, widths[i])))
        .join(' '.repeat(gap))
        .trimEnd()
    )
    .join('\n')
}

/** Word-wraps plain text to `columns`, keeping its own line breaks. */
export function wrap(text: string, columns: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && width(line) + 1 + width(word) > columns) {
        out.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    out.push(line)
  }
  return out
}

/** Text in a rounded box with a title in the top border. */
export function panel(text: string, title: string, border: Style = 'dim'): string {
  const inner = Math.max(20, terminalWidth() - 4)
  const lines = wrap(text, inner)
  const contentWidth = Math.max(width(title) + 2, ...lines.map(width))
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, contentWidth - width(title) - 1))}╮`
  const body = lines.map((l) => `${style(border, '│')} ${padEnd(l, contentWidth)} ${style(border, '│')}`)
  const bottom = `╰${'─'.repeat(contentWidth + 2)}╯`
  return [style(border, top), ...body, style(border, bottom)].join('\n')
}

function arrow(change: number): [string, Style] {
  if (change > 0) return ['▲', 'green']
  if (change < 0) return ['▼', 'red']
  return ['•', 'white']
}

const fmt = (v: number, digits = 2): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`

export function fmtVolume(v: number): string {
  for (const [unit, div] of [['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (v >= div) return `${(v / div).toFixed(1)}${unit}`
  }
  return v.toFixed(0)
}

/** Detailed block for a single ticker. */
export function showQuote(q: Quote): string {
  const [mark, color] = arrow(q.change)
  const dot = q.code.lastIndexOf('.')
  const base = dot > 0 ? q.code.slice(0, dot) : q.code
  const exchange = dot > 0 ? q.code.slice(dot + 1) : ''
  return [
    bold(base) + ' '.repeat(Math.max(1, 44 - width(base) - width(exchange))) + dim(exchange),
    `${bold(fmt(q.price))}   ${style(color, `${mark} ${signed(q.change)}  (${signed(q.percent)}%)`)}`,
    dim('─'.repeat(44)),
    table(
      [
        [`${dim('open  ')} ${fmt(q.open)}`, `${dim('volume')} ${fmtVolume(q.volume)}`],
        [`${dim('range ')} ${fmt(q.low)} – ${fmt(q.high)}`, `${dim('prev  ')} ${fmt(q.prevClose)}`]
      ],
      { gap: 4 }
    ),
    ''
  ].join('\n')
}

/** One row per ticker for a multi-ticker request. */
export function showQuotesCompact(quotes: Quote[]): string {
  return (
    table(
      quotes.map((q) => {
        const [mark, color] = arrow(q.change)
        return [bold(q.code), fmt(q.price), style(color, `${mark} ${signed(q.change)}`), style(color, `(${signed(q.percent)}%)`)]
      }),
      { right: [1] }
    ) + '\n'
  )
}

export function showQuotes(quotes: Quote[]): string {
  if (!quotes.length) return ''
  return quotes.length === 1 ? showQuote(quotes[0]) : showQuotesCompact(quotes)
}

/** OHLC bars, oldest first, closes colored against the previous close. */
export function showPriceHistory(bars: Bar[], code = ''): string {
  if (!bars.length) return dim('no historical data') + '\n'
  const rows = [['date', 'open', 'high', 'low', 'close', 'volume'].map(dim)]
  let prev: number | null = null
  for (const b of bars) {
    const [mark, color] = arrow(prev === null ? 0 : b.close - prev)
    rows.push([b.date.slice(0, 10), fmt(b.open), fmt(b.high), fmt(b.low), style(color, `${mark} ${fmt(b.close)}`), fmtVolume(b.volume)])
    prev = b.close
  }
  return (code ? bold(code) + '\n' : '') + table(rows, { right: [1, 2, 3, 4, 5] }) + '\n'
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`)
const money = (v: number | null): string => (v === null ? 'n/a' : fmtVolume(v))
const ratio = (v: number | null): string => (v === null ? 'n/a' : fmt(v))

export function showFundamentals(f: Fundamentals): string {
  const pair = (a: string, av: string, b: string, bv: string): string[] => [`${dim(a)} ${av}`, `${dim(b)} ${bv}`]
  return [
    `${bold(f.code)}  ${dim(f.name ?? '')}    ${dim(`${f.sector ?? '—'} · ${f.industry ?? '—'}`)}`,
    dim('─'.repeat(44)),
    table(
      [
        pair('market cap', money(f.marketCap), 'ebitda', money(f.ebitda)),
        pair('revenue ttm', money(f.revenueTtm), 'eps', ratio(f.eps)),
        pair('profit margin', pct(f.profitMargin), 'operating margin', pct(f.operatingMargin)),
        pair('roe', pct(f.roe), 'roa', pct(f.roa)),
        pair('revenue growth yoy', pct(f.revenueGrowth), 'earnings growth yoy', pct(f.earningsGrowth)),
        pair('p/e', ratio(f.trailingPE), 'peg', ratio(f.pegRatio)),
        pair('dividend yield', pct(f.dividendYield), 'analyst target', ratio(f.targetMeanPrice))
      ],
      { gap: 4 }
    ),
    ''
  ].join('\n')
}

function sentimentArrow(polarity: number | undefined): [string, Style] {
  if (typeof polarity !== 'number') return ['•', 'white']
  if (polarity > 0.1) return ['▲', 'green']
  if (polarity < -0.1) return ['▼', 'red']
  return ['•', 'white']
}

/** Headlines: date, sentiment arrow, title, and the link under it. */
export function showNews(articles: Article[]): string {
  if (!articles.length) return dim('no recent news') + '\n'
  const rows: string[][] = []
  for (const a of articles) {
    const [mark, color] = sentimentArrow(a.sentiment?.polarity)
    rows.push([dim((a.date || '').slice(0, 10)), style(color, mark), bold(a.title)], ['', '', dim(a.link)])
  }
  return table(rows, { gap: 1 }) + '\n'
}

export function showGeoNews(articles: GeoArticle[]): string {
  if (!articles.length) return dim('no relevant world news') + '\n'
  const rows: string[][] = []
  for (const a of articles) {
    const s = (a.sentiment || '').toLowerCase()
    const [mark, color]: [string, Style] = s === 'positive' ? ['▲', 'green'] : s === 'negative' ? ['▼', 'red'] : ['•', 'white']
    rows.push([dim((a.date || '').slice(0, 10)), dim(a.country || '?'), style(color, mark), bold(a.title)], ['', '', '', dim(a.link)])
  }
  return table(rows, { gap: 1 }) + '\n'
}

/** The four specialist write-ups plus the aggregator's risk assessment. */
export function showAnalysis(result: AnalysisResult): string {
  return [
    panel(result.trendText, 'trend'),
    panel(result.fundamentalsText, 'fundamentals'),
    panel(result.newsText, 'news'),
    panel(result.geopoliticsText, 'geopolitics'),
    panel(result.verdictText, 'risk assessment', 'yellow'),
    dim('not financial advice -- for research purposes only.'),
    ''
  ].join('\n')
}

/** Whatever data a chat answer or analysis came back with. */
export function showResultData(data: {
  quotes: Quote[]
  bars: Bar[]
  fundamentals: Fundamentals | null
  articles: Article[]
  geoArticles: GeoArticle[]
}): string {
  return [
    showQuotes(data.quotes),
    data.bars.length ? showPriceHistory(data.bars) : '',
    data.fundamentals ? showFundamentals(data.fundamentals) : '',
    data.articles.length ? showNews(data.articles) : '',
    data.geoArticles.length ? showGeoNews(data.geoArticles) : ''
  ]
    .filter(Boolean)
    .join('\n')
}
