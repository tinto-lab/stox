import { useEffect, useRef, useState } from 'react'
import type { TranscriptItem } from '../useBridge'

type ReasoningItem = Extract<TranscriptItem, { kind: 'reasoning' }>

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

/**
 * The model's reasoning for one model call (DeepSeek thinking mode). While
 * it streams it's shown live, scrolled to the latest line; once the call
 * moves on it folds to a one-line "Thought for Ns" that expands on click.
 */
export function ReasoningBlock({ item }: { item: ReasoningItem }) {
  const live = item.endedAt === null
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Ticks the "Thinking… Ns" timer while streaming.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  useEffect(() => {
    if (live) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [live, item.text])

  // A model call that hasn't produced (or won't produce) any reasoning.
  if (!item.text) return null

  const who = item.agent ? `${item.agent} · ` : ''
  const label = live
    ? `${who}Thinking… ${seconds(now - item.startedAt)}`
    : `${who}Thought for ${seconds(item.lastAt - item.startedAt)}`

  return (
    <div className={`reasoning ${live ? 'reasoning-live' : ''}`}>
      <button
        type="button"
        className="reasoning-head"
        onClick={() => setExpanded((e) => !e)}
        disabled={live}
        aria-expanded={live || expanded}
      >
        {label} {!live && (expanded ? '▾' : '▸')}
      </button>
      {(live || expanded) && (
        <div ref={bodyRef} className={`reasoning-body ${live ? 'reasoning-body-live' : ''}`}>
          {item.text}
        </div>
      )}
    </div>
  )
}
