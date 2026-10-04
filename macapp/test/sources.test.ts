import { describe, expect, it } from 'vitest'
import { ARTICLE_URL, GNewsError, decodeLink, fetchGeoNews, isRedirectLink, parseFeed } from '../src/core/gnews'
import { extractText, fetchArticleText } from '../src/core/webfetch'
import { stubFetch } from './helpers'

const rss = (items: string): string => `<?xml version="1.0"?><rss><channel><title>t</title>${items}</channel></rss>`
const item = (title: string, link: string, source = 'Reuters', pubDate = 'Thu, 24 Sep 2026 06:38:16 GMT'): string =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate><source url="https://reuters.com">${source}</source></item>`

describe('Google News feed', () => {
  it('strips the publisher suffix, converts the date, names the publisher in the summary', () => {
    const [a] = parseFeed(rss(item('Chip curbs widen - Reuters', `${ARTICLE_URL}abc`)))
    expect(a).toEqual({
      title: 'Chip curbs widen',
      date: '2026-09-24T06:38:16.000Z',
      link: `${ARTICLE_URL}abc`,
      country: '',
      sentiment: '',
      summary: '(headline only, from Reuters)'
    })
  })

  it('skips untitled items, keeps an unparseable date as-is, decodes entities', () => {
    const articles = parseFeed(rss(item('', 'x') + item('Tariffs &amp; trade', 'y', '', 'someday')))
    expect(articles).toHaveLength(1)
    expect(articles[0]).toMatchObject({ title: 'Tariffs & trade', date: 'someday', summary: '' })
  })

  it('an empty feed is an empty list; garbage is an error', () => {
    expect(parseFeed(rss(''))).toEqual([])
    expect(() => parseFeed('<html>nope</html>')).toThrow(GNewsError)
  })

  it('knows an undecoded redirect link', () => {
    expect(isRedirectLink(`${ARTICLE_URL}abc`)).toBe(true)
    expect(isRedirectLink('https://reuters.com/x')).toBe(false)
    expect(isRedirectLink('')).toBe(false)
  })
})

describe('Google News link decoding', () => {
  const page = '<c-wiz data-n-a-sg="SIG" data-n-a-ts="1700000000"></c-wiz>'
  const batch = (url: string): string =>
    `)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', url, 1])]])}`

  it('resolves the publisher url through the signed batchexecute call', async () => {
    const fetch = stubFetch({
      [ARTICLE_URL]: () => new Response(page),
      'https://news.google.com/_/DotsSplashUi/data/batchexecute': () => new Response(batch('https://reuters.com/story'))
    })
    expect(await decodeLink(`${ARTICLE_URL}abc?oc=5`)).toBe('https://reuters.com/story')
    const body = (fetch.mock.calls[1][1] as RequestInit).body as URLSearchParams
    const [[[rpc, req]]] = JSON.parse(body.get('f.req')!)
    expect(rpc).toBe('Fbv4je')
    expect(JSON.parse(req).slice(-3)).toEqual(['abc', 1700000000, 'SIG'])
  })

  it('returns null without a signature, on a garbled reply, on a network error, or for other links', async () => {
    stubFetch({ [ARTICLE_URL]: () => new Response('<html></html>') })
    expect(await decodeLink(`${ARTICLE_URL}abc`)).toBeNull()
    stubFetch({
      [ARTICLE_URL]: () => new Response(page),
      'https://news.google.com/_/': () => new Response('garbage')
    })
    expect(await decodeLink(`${ARTICLE_URL}abc`)).toBeNull()
    stubFetch({
      [ARTICLE_URL]: () => {
        throw new TypeError('offline')
      }
    })
    expect(await decodeLink(`${ARTICLE_URL}abc`)).toBeNull()
    expect(await decodeLink('https://reuters.com/x')).toBeNull()
  })
})

describe('fetchGeoNews', () => {
  const feed = rss(item('One - Reuters', `${ARTICLE_URL}one`) + item('Two - AP', `${ARTICLE_URL}two`))

  it('searches the past week, limits, and decodes links (keeping ones that fail)', async () => {
    const fetch = stubFetch({
      'https://news.google.com/rss/search': () => new Response(feed),
      [`${ARTICLE_URL}one`]: () => new Response('<c-wiz data-n-a-sg="S" data-n-a-ts="1"></c-wiz>'),
      [`${ARTICLE_URL}two`]: () => new Response('no signature'),
      'https://news.google.com/_/': () =>
        new Response(`)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['x', 'https://reuters.com/one'])]])}`)
    })
    const articles = await fetchGeoNews('tariffs OR "export controls"', 5)
    expect(articles.map((a) => a.link)).toEqual(['https://reuters.com/one', `${ARTICLE_URL}two`])
    const q = new URL(fetch.mock.calls[0][0] as string).searchParams
    expect(q.get('q')).toBe('(tariffs OR "export controls") when:7d')
    expect(q.get('ceid')).toBe('US:en')

    expect(await fetchGeoNews('x', 1)).toHaveLength(1)
  })

  it('caches results', async () => {
    const fetch = stubFetch({ 'https://news.google.com/rss/search': () => new Response(rss('')) })
    await fetchGeoNews('oil')
    await fetchGeoNews('oil')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports network and HTTP errors', async () => {
    stubFetch({
      'https://news.google.com/rss/search': () => {
        throw new TypeError('offline')
      }
    })
    await expect(fetchGeoNews('a')).rejects.toThrow(/network error: offline/)
    stubFetch({ 'https://news.google.com/rss/search': () => new Response('', { status: 503 }) })
    await expect(fetchGeoNews('b')).rejects.toThrow(/HTTP 503/)
  })
})

describe('article extraction', () => {
  const page = (body: string): string =>
    `<html><head><title>T</title></head><body><nav>Home | Markets | Login</nav><article><h1>Headline</h1>${body}</article><footer>© 2026 Cookie settings</footer></body></html>`
  const paragraphs = Array.from(
    { length: 6 },
    (_, i) => `<p>Paragraph ${i} explains in some detail what happened to the company's shares this week and why.</p>`
  ).join('')

  it('pulls the article text out of the page, without the chrome', () => {
    const text = extractText(page(paragraphs), 'https://example.com/a')!
    expect(text).toContain('Paragraph 0 explains')
    expect(text).toContain('Paragraph 5')
    expect(text).not.toContain('Cookie settings')
  })

  it('rejects non-http urls before fetching', async () => {
    for (const url of ['', 'ftp://x', 'javascript:alert(1)', 'example.com']) {
      await expect(fetchArticleText(url)).rejects.toThrow(/not a valid http\(s\) URL/)
    }
  })

  it('returns null for a page with no article', () => {
    expect(extractText('<html><body></body></html>', 'https://example.com')).toBeNull()
  })
})
