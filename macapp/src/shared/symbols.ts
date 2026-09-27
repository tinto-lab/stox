/** Same convention as stoxlib/quotes.normalize: a bare symbol is a US listing. */
export function normalize(ticker: string): string {
  const t = ticker.trim().toUpperCase()
  return t.includes('.') ? t : `${t}.US`
}

/** The ticker as a person would write it: `AAPL.US` -> `AAPL`, anything else unchanged. */
export function displaySymbol(code: string): string {
  return code.endsWith('.US') ? code.slice(0, -3) : code
}
