import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CHARS, fetchArticleText } from '../src/core/webfetch'

// fetchArticleText goes through undici's fetch (for its larger header
// limit), not the global one.
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<object>()), fetch: fetchMock }))

const page = (words: number): string =>
  `<html><body><article><h1>Headline</h1>${Array.from(
    { length: Math.ceil(words / 10) },
    () => '<p>alpha beta gamma delta epsilon zeta eta theta iota kappa.</p>'
  ).join('')}</article></body></html>`

describe('fetchArticleText', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns the extracted text', async () => {
    fetchMock.mockResolvedValue(new Response(page(60)))
    const text = await fetchArticleText('https://example.com/a')
    expect(text).toMatch(/alpha beta gamma/)
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined()
  })

  it('cuts long text at a word boundary', async () => {
    fetchMock.mockResolvedValue(new Response(page(2000)))
    const text = await fetchArticleText('https://example.com/a')
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
    expect(text.slice(-2, -1)).not.toBe(' ')
  })

  it('reports HTTP errors, network errors, and pages with nothing to extract', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }))
    await expect(fetchArticleText('https://example.com/a')).rejects.toThrow(/HTTP 403/)
    fetchMock.mockRejectedValue(new TypeError('offline'))
    await expect(fetchArticleText('https://example.com/a')).rejects.toThrow(/network error: offline/)
    fetchMock.mockResolvedValue(new Response('<html><body></body></html>'))
    await expect(fetchArticleText('https://example.com/a')).rejects.toThrow(/couldn't extract/)
  })
})
