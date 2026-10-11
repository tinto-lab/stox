import { useCallback, useEffect, useRef, useState } from 'react'
import type { BridgeEvent } from '../../shared/bridgeProtocol'
import {
  type TranscriptItem,
  addReasoning,
  addText,
  dropStreamedText,
  endReasoning,
  makeId,
  resumedTranscript
} from './transcript'

import type {
  AgentResult,
  AnalysisResult,
  ChatStatus,
  ConversationSummary,
  QuoteResult,
  ResumedConversation,
  ViewContext
} from '../../shared/types'

export type { TranscriptItem } from './transcript'

type PendingKind = 'ask' | 'quote' | 'analyze' | 'reset' | 'resume'

/** Chat state for the side panel, driven by the main process's ChatSession.
 * `enabled` stays false until the panel is first opened, so a session that
 * only uses the dashboard never asks for the chat's status. */
export function useBridge(enabled: boolean) {
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const [considerations, setConsiderations] = useState<string[]>([])
  const [status, setStatus] = useState<ChatStatus | null>(null)
  // null while a list is on its way, so the menu doesn't flash an old or empty one.
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)
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
      if (event.type === 'backend_exit') {
        // Whatever was in flight died with the process and will never be answered.
        pending.current.clear()
        setIsBusy(false)
        if (event.message) append({ kind: 'error', id: makeId(), message: event.message })
        return
      }
      if (event.id === null) {
        if (event.type === 'error') append({ kind: 'error', id: makeId(), message: event.message })
        return
      }

      const id = event.id
      if (event.type === 'text') {
        setTranscript((prev) => addText(prev, id, event.delta))
        return
      }
      if (event.type === 'reasoning') {
        setTranscript((prev) => addReasoning(prev, id, event.agent, event.step, event.delta))
        return
      }
      // Anything else from a request means the model call that was thinking has moved on.
      if (event.type === 'tool_call') {
        setTranscript((prev) => [
          ...endReasoning(dropStreamedText(prev, id), id, null),
          { kind: 'tool_call', id, name: event.name, args: event.args }
        ])
        return
      }
      if (event.type === 'specialist_start') {
        append({ kind: 'specialist_start', id: event.id, name: event.name })
        return
      }
      if (event.type === 'specialist_tool_call') {
        setTranscript((prev) => [
          ...endReasoning(prev, id, event.agent),
          { kind: 'specialist_tool_call', id, agent: event.agent, name: event.name, args: event.args }
        ])
        return
      }

      setTranscript((prev) => endReasoning(dropStreamedText(prev, id), id))
      const requestKind = pending.current.get(event.id)
      pending.current.delete(event.id)
      if (requestKind) setIsBusy(false)

      if (event.type === 'error') {
        append({ kind: 'error', id: event.id, message: event.message })
        return
      }

      switch (requestKind) {
        case 'ask': {
          append({ kind: 'assistant_result', id: event.id, ...(event.data as AgentResult) })
          break
        }
        case 'quote': {
          const data = event.data as QuoteResult
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
        case 'resume': {
          setTranscript(resumedTranscript(event.data as ResumedConversation))
          break
        }
        default: {
          // considerations_* / conversations_list / status / set_thinking
          const data = event.data as Partial<
            { considerations: string[]; conversations: ConversationSummary[] } & ChatStatus
          >
          if (data.considerations) setConsiderations(data.considerations)
          if (data.conversations) setConversations(data.conversations)
          if (data.provider) setStatus(data as ChatStatus)
        }
      }
    })

    return unsubscribe
  }, [append])

  // Fetched when the chat panel is first opened.
  useEffect(() => {
    if (!enabled) return
    refreshConsiderations()
    refreshStatus()
  }, [enabled, refreshConsiderations, refreshStatus])

  const ask = useCallback(
    (text: string, contexts?: ViewContext[]) => {
      const id = makeId()
      pending.current.set(id, 'ask')
      setIsBusy(true)
      append({ kind: 'user_message', id, text })
      window.stox.send({ id, cmd: 'ask', text, contexts })
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

  const listConversations = useCallback(() => {
    setConversations(null)
    window.stox.send({ id: makeId(), cmd: 'conversations_list' })
  }, [])

  const resume = useCallback((conversationId: string) => {
    const id = makeId()
    pending.current.set(id, 'resume')
    setIsBusy(true)
    window.stox.send({ id, cmd: 'resume', conversationId })
  }, [])

  const addConsideration = useCallback((text: string) => {
    window.stox.send({ id: makeId(), cmd: 'considerations_add', text })
  }, [])

  const removeConsideration = useCallback((text: string) => {
    window.stox.send({ id: makeId(), cmd: 'considerations_remove', text })
  }, [])

  // Answered with the updated status, which the default branch above picks up.
  const setThinking = useCallback((enabled: boolean) => {
    window.stox.send({ id: makeId(), cmd: 'set_thinking', enabled })
  }, [])

  return {
    transcript,
    isBusy,
    considerations,
    status,
    conversations,
    ask,
    quote,
    analyze,
    reset,
    listConversations,
    resume,
    addConsideration,
    removeConsideration,
    setThinking,
    refreshStatus
  }
}
