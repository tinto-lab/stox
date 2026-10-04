import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { Agent, fetch } from 'undici'

/**
 * Turns a URL into readable article text: fetches the page and extracts the
 * main content with Mozilla's Readability (Firefox's reader view), dropping
 * nav, ads and boilerplate. Used so the agent reads a news article's full
 * text rather than the provider's one-paragraph summary.
 */

const REQUEST_TIMEOUT_MS = 10_000
export const MAX_CHARS = 4000

const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; stox/1.0; terminal research tool)' }

// News sites (Yahoo Finance among them) can send response headers well past
// Node's default 16 KB limit, which fails the request before the page is
// read; publishers' pages are fetched through an agent that allows more.
const agent = new Agent({ maxHeaderSize: 256 * 1024 })

export class FetchError extends Error {}

/** Readable text of an HTML page, or null if there's no article in it. */
export function extractText(html: string, url: string): string | null {
  const { document } = parseHTML(html)
  // Readability resolves relative links against the document's URL.
  try {
    Object.defineProperty(document, 'documentURI', { value: url })
  } catch {
    // not needed for the text itself
  }
  const article = new Readability(document as unknown as Document).parse()
  const text = article?.textContent?.split(/\s+/).filter(Boolean).join(' ') ?? ''
  return text || null
}

/** Downloads `url` and returns its main readable text, cut to `maxChars` at a word boundary. */
export async function fetchArticleText(url: string, maxChars = MAX_CHARS): Promise<string> {
  if (!/^https?:\/\//.test(url || '')) throw new FetchError('not a valid http(s) URL')

  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(url, { headers: HEADERS, dispatcher: agent, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (e) {
    throw new FetchError(`network error: ${(e as Error).message}`)
  }
  if (response.status !== 200) throw new FetchError(`server returned HTTP ${response.status}`)

  const text = extractText(await response.text(), url)
  if (!text) throw new FetchError("couldn't extract readable article text from this page")
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut) + '…'
}
