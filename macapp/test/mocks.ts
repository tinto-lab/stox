import { type Mock, vi } from 'vitest'

/**
 * Module mocks for the data sources, shared by the agent-level tests:
 * importing this file (before the code under test) swaps marketData's
 * fetchers, Google News search and article fetching for vi.fn()s.
 */
export const data: Record<
  'fetchQuotes' | 'fetchBars' | 'fetchFundamentals' | 'fetchNews' | 'fetchGeoNews' | 'fetchArticleText',
  Mock
> = {
  fetchQuotes: vi.fn(),
  fetchBars: vi.fn(),
  fetchFundamentals: vi.fn(),
  fetchNews: vi.fn(),
  fetchGeoNews: vi.fn(),
  fetchArticleText: vi.fn()
}

vi.mock('../src/core/marketData', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchQuotes: data.fetchQuotes,
  fetchBars: data.fetchBars,
  fetchFundamentals: data.fetchFundamentals,
  fetchNews: data.fetchNews
}))
vi.mock('../src/core/gnews', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchGeoNews: data.fetchGeoNews
}))
vi.mock('../src/core/webfetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchArticleText: data.fetchArticleText
}))
