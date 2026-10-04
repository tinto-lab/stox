import { XMLParser } from 'fast-xml-parser'
import type { GeoArticle } from '../shared/types'

/**
 * Google News RSS: free, keyless world/geopolitical news search.
 *
 * Unlike EODHD's ticker-scoped news, geopolitical and macro events aren't
 * indexed by symbol -- tariffs, sanctions, elections and regional conflicts
 * move a stock without ever mentioning its ticker -- so this takes a
 * free-text query instead.
 *
 * Two quirks absorbed here so callers don't have to:
 *
 * - Each item's <link> is a news.google.com redirect, not the publisher's
 *   URL, so article extraction (webfetch.ts) can't read it as-is. Each one is
 *   decoded to the real URL through the same two-step lookup Google's own
 *   page uses (see decodeLink); if that fails the redirect is kept and the
 *   article just falls back to its summary.
 * - The feed carries no article text, country or sentiment -- only title,
 *   date and publisher -- so those fields stay empty and the summary names
 *   the publisher instead.
 */

export const RSS_URL = 'https://news.google.com/rss/search'
export const ARTICLE_URL = 'https://news.google.com/rss/articles/'
const BATCHEXECUTE_URL = 'https://news.google.com/_/DotsSplashUi/data/batchexecute'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_DECODE_WORKERS = 5

/** Past week. `when:` is Google News's own search operator. */
const DEFAULT_LOOKBACK = 'when:7d'
const LOCALE_PARAMS = { hl: 'en-US', gl: 'US', ceid: 'US:en' }

const USER_AGENT = 'Mozilla/5.0 (compatible; stox/1.0; terminal research tool)'
// With a Mozilla-style User-Agent the redirect page bounces to
// consent.google.com's cookie banner instead. SOCS=CAI is the cookie Google
// sets for "Reject all" on that banner -- sending it skips the banner.
const HEADERS = { 'user-agent': USER_AGENT, cookie: 'SOCS=CAI' }

export class GNewsError extends Error {}

// Short-lived cache keyed on the exact request, so a specialist trying
// overlapping search angles -- or two runs for the same ticker minutes
// apart -- doesn't redo the several-request lookup.
const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; articles: GeoArticle[] }>()

export function clearGeoNewsCache(): void {
  cache.clear()
}

/** RFC 822 pubDate -> ISO 8601, so callers can slice(0, 10) for the day. */
function isoDate(pubDate: unknown): string {
  if (typeof pubDate !== 'string') return ''
  const t = Date.parse(pubDate)
  return Number.isNaN(t) ? pubDate : new Date(t).toISOString()
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (value && typeof value === 'object' && '#text' in value) return text((value as { '#text': unknown })['#text'])
  return ''
}

export function parseFeed(xml: string): GeoArticle[] {
  let doc: unknown
  try {
    doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml)
  } catch (e) {
    throw new GNewsError(`couldn't parse server response: ${(e as Error).message}`)
  }
  const channel = (doc as { rss?: { channel?: { item?: unknown } } })?.rss?.channel
  if (!channel) throw new GNewsError("couldn't parse server response")
  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : []

  const articles: GeoArticle[] = []
  for (const item of items as Record<string, unknown>[]) {
    let title = text(item.title)
    if (!title) continue
    const source = text(item.source)
    // Google appends " - Publisher" to every title; the summary already names it.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
    articles.push({
      title,
      date: isoDate(item.pubDate),
      link: text(item.link),
      country: '',
      sentiment: '',
      summary: source ? `(headline only, from ${source})` : ''
    })
  }
  return articles
}

/** True for a news.google.com redirect that couldn't be decoded -- fetching
 * it yields Google's consent page, not the article, so callers should use
 * the summary instead. */
export function isRedirectLink(link: string): boolean {
  return (link || '').startsWith(ARTICLE_URL)
}

/**
 * Resolves a news.google.com/rss/articles/<id> redirect to the publisher's
 * URL, or null. The id alone isn't enough: the redirect page embeds a
 * signature and timestamp (data-n-a-sg / data-n-a-ts) that Google's
 * batchexecute endpoint needs alongside it.
 */
export async function decodeLink(link: string): Promise<string | null> {
  const id = /\/articles\/([^?/]+)/.exec(link || '')?.[1]
  if (!id) return null
  try {
    const page = await (
      await fetch(ARTICLE_URL + id, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    ).text()
    const sig = /data-n-a-sg="([^"]+)"/.exec(page)?.[1]
    const ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1]
    if (!sig || !ts) return null
    const req = [
      'garturlreq',
      [
        ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
        'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0
      ],
      id, Number(ts), sig
    ]
    const response = await fetch(BATCHEXECUTE_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ 'f.req': JSON.stringify([[['Fbv4je', JSON.stringify(req), null, 'generic']]]) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    // The body is an anti-XSSI prefix line, a blank line, then JSON.
    const body = await response.text()
    const payload = JSON.parse(body.slice(body.indexOf('\n\n') + 2)) as unknown[][]
    const url = (JSON.parse(payload[0][2] as string) as unknown[])[1]
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export interface GeoNewsOptions {
  limit?: number
  /** A Google News `when:` operator; default past week. */
  lookback?: string
  /** false keeps each article's news.google.com redirect instead of resolving
   * it -- two extra requests per article that a caller only reading
   * headlines (the news watcher) doesn't need. */
  decodeLinks?: boolean
}

/** Recent world-news articles matching a free-text query (not a ticker). */
export async function fetchGeoNews(query: string, options: GeoNewsOptions = {}): Promise<GeoArticle[]> {
  const { limit = 5, lookback = DEFAULT_LOOKBACK, decodeLinks = true } = options
  const key = JSON.stringify([query, limit, lookback, decodeLinks])
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.articles

  // Parenthesized so an OR in the query doesn't swallow the date window
  // ("a OR b when:7d" would only limit the b side).
  const params = new URLSearchParams({ q: `(${query}) ${lookback}`, ...LOCALE_PARAMS })
  let response: Response
  try {
    response = await fetch(`${RSS_URL}?${params}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (e) {
    throw new GNewsError(`network error: ${(e as Error).message}`)
  }
  if (!response.ok) throw new GNewsError(`server returned HTTP ${response.status}`)

  const articles = parseFeed(await response.text()).slice(0, Math.max(1, limit))
  if (articles.length && decodeLinks) {
    const real = await mapLimit(articles, MAX_DECODE_WORKERS, (a) => decodeLink(a.link))
    articles.forEach((a, i) => {
      if (real[i]) a.link = real[i]
    })
  }
  cache.set(key, { at: Date.now(), articles })
  return articles
}
