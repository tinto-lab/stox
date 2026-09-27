import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentResultData,
  AnalysisResult,
  Article,
  Bar,
  BridgeEvent,
  ConsiderationsData,
  Fundamentals,
  GeoArticle,
  Quote,
  QuoteResultData,
  StatusData
} from './protocol'

export type TranscriptItem =
  | { kind: 'user_message'; id: string; text: string }
  | {
      kind: 'assistant_result'
      id: string
      text: string
      quotes: Quote[]
      articles: Article[]
      geoArticles: GeoArticle[]
      bars: Bar[]
      fundamentals: Fundamentals | null
      analysis: AnalysisResult | null
    }
  | { kind: 'quote_result'; id: string; quotes: Quote[]; missing: string[] }
  | { kind: 'analysis_result'; id: string; analysis: AnalysisResult }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'specialist_start'; id: string; name: string }
  | { kind: 'specialist_tool_call'; id: string; agent: string; name: string; args: Record<string, unknown> }
  | { kind: 'error'; id: string; message: string }

type PendingKind = 'ask' | 'quote' | 'analyze' | 'reset'

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function useBridge() {
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const [considerations, setConsiderations] = useState<string[]>([])
  const [status, setStatus] = useState<StatusData | null>(null)
  const pending = useRef(new Map<string, PendingKind>())

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => [...prev, item])
  }, [])

  const refreshConsiderations = useCallback(() => {
    window.stox.send({ id: makeId(), cmd: 'considerations_list' })
  }, [])

  const refreshStatus = useCallback(() => {
    window.stox.send({ id: makeId(), cmd: 'status' })
  }, [])

  useEffect(() => {
    const unsubscribe = window.stox.onEvent((event: BridgeEvent) => {
      if (event.id === null) {
        if (event.type === 'error') append({ kind: 'error', id: makeId(), message: event.message })
        return
      }

      if (event.type === 'tool_call') {
        append({ kind: 'tool_call', id: event.id, name: event.name, args: event.args })
        return
      }
      if (event.type === 'specialist_start') {
        append({ kind: 'specialist_start', id: event.id, name: event.name })
        return
      }
      if (event.type === 'specialist_tool_call') {
        append({
          kind: 'specialist_tool_call',
          id: event.id,
          agent: event.agent,
          name: event.name,
          args: event.args
        })
        return
      }

      const requestKind = pending.current.get(event.id)
      pending.current.delete(event.id)
      if (requestKind) setIsBusy(false)

      if (event.type === 'error') {
        append({ kind: 'error', id: event.id, message: event.message })
        return
      }

      switch (requestKind) {
        case 'ask': {
          const data = event.data as AgentResultData
          append({
            kind: 'assistant_result',
            id: event.id,
            text: data.text,
            quotes: data.quotes,
            articles: data.articles,
            geoArticles: data.geo_articles,
            bars: data.bars,
            fundamentals: data.fundamentals,
            analysis: data.analysis
          })
          break
        }
        case 'quote': {
          const data = event.data as QuoteResultData
          append({ kind: 'quote_result', id: event.id, quotes: data.quotes, missing: data.missing })
          break
        }
        case 'analyze': {
          append({ kind: 'analysis_result', id: event.id, analysis: event.data as AnalysisResult })
          break
        }
        case 'reset': {
          setTranscript([])
          break
        }
        default: {
          // considerations_list / considerations_add / considerations_remove / status
          const data = event.data as Partial<ConsiderationsData & StatusData>
          if (data.considerations) setConsiderations(data.considerations)
          if (data.provider) setStatus(data as StatusData)
        }
      }
    })

    refreshConsiderations()
    refreshStatus()

    return unsubscribe
  }, [append, refreshConsiderations, refreshStatus])

  const ask = useCallback(
    (text: string) => {
      const id = makeId()
      pending.current.set(id, 'ask')
      setIsBusy(true)
      append({ kind: 'user_message', id, text })
      window.stox.send({ id, cmd: 'ask', text })
    },
    [append]
  )

  const quote = useCallback(
    (tickers: string[]) => {
      const id = makeId()
      pending.current.set(id, 'quote')
      setIsBusy(true)
      append({ kind: 'user_message', id, text: `/price ${tickers.join(' ')}` })
      window.stox.send({ id, cmd: 'quote', tickers })
    },
    [append]
  )

  const analyze = useCallback(
    (ticker: string) => {
      const id = makeId()
      pending.current.set(id, 'analyze')
      setIsBusy(true)
      append({ kind: 'user_message', id, text: `/analyze ${ticker}` })
      window.stox.send({ id, cmd: 'analyze', ticker })
    },
    [append]
  )

  const reset = useCallback(() => {
    const id = makeId()
    pending.current.set(id, 'reset')
    window.stox.send({ id, cmd: 'reset' })
  }, [])

  const addConsideration = useCallback((text: string) => {
    window.stox.send({ id: makeId(), cmd: 'considerations_add', text })
  }, [])

  const removeConsideration = useCallback((text: string) => {
    window.stox.send({ id: makeId(), cmd: 'considerations_remove', text })
  }, [])

  return {
    transcript,
    isBusy,
    considerations,
    status,
    ask,
    quote,
    analyze,
    reset,
    addConsideration,
    removeConsideration,
    refreshStatus
  }
}
