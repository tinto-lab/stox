/** Icons for the chat input's buttons. They draw in `currentColor`. */

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

/** Dictation: a sound wave. While `live`, the bars dance. */
export function WaveIcon({ live = false }: { live?: boolean }) {
  const bars = [
    { x: 4, h: 5 },
    { x: 8, h: 11 },
    { x: 12, h: 17 },
    { x: 16, h: 11 },
    { x: 20, h: 5 }
  ]
  return (
    <svg {...base} className={live ? 'wave-icon live' : 'wave-icon'}>
      {bars.map(({ x, h }, i) => (
        <line key={x} x1={x} x2={x} y1={12 - h / 2} y2={12 + h / 2} style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </svg>
  )
}

/** Send: the Enter / return key. */
export function EnterIcon() {
  return (
    <svg {...base}>
      <path d="M20 5v6a3 3 0 0 1-3 3H5" />
      <path d="M9 9l-4 5 4 5" />
    </svg>
  )
}
