const DASH = '—'

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtPrice(value: number | null | undefined): string {
  // Sub-dollar prices (penny stocks, many crypto pairs, FX) need more precision to be useful.
  if (value !== null && value !== undefined && Math.abs(value) > 0 && Math.abs(value) < 1) return fmtNumber(value, 4)
  return fmtNumber(value, 2)
}

/** A fraction (0.1234) as a percentage ("12.34%"). */
export function fmtPercent(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH
  return `${(fraction * 100).toFixed(digits)}%`
}

export function fmtSignedPercent(percent: number): string {
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`
}

/** A price change, at the same precision as the price it's a change of. */
export function fmtChange(change: number, price: number): string {
  return `${change >= 0 ? '+' : ''}${fmtNumber(change, Math.abs(price) < 1 ? 4 : 2)}`
}

/** Large amounts in compact form: 3.21T, 45.6B, 789M, 12.3K. */
export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`
  return `${sign}${abs.toFixed(0)}`
}

export function fmtTime(unixSeconds: number | null): string {
  if (unixSeconds === null) return ''
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function changeClass(value: number): string {
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}
