import { fetchFundamentals, fetchHistory, fetchQuotes, hasEodhdKey, searchSymbols } from '../core/marketData'
import type { WatchlistEntry } from '../shared/types'
import { handle } from './ipc'
import { readWatchlist, writeWatchlist } from './watchlist'

/** Market data and the watchlist (see MarketApi and WatchlistApi). */
export function registerMarketIpc(): void {
  handle('market:quotes', fetchQuotes)
  handle('market:history', fetchHistory)
  handle('market:fundamentals', fetchFundamentals)
  handle('market:search', searchSymbols)
  handle('market:status', () => ({ hasEodhdKey: hasEodhdKey() }))

  handle('watchlist:read', readWatchlist)
  handle('watchlist:write', (entries: WatchlistEntry[]) => writeWatchlist(entries))
}
