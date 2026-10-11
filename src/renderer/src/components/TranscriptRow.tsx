import type { TranscriptItem } from '../useBridge'
import { AnalysisView } from './AnalysisView'
import { FundamentalsCard } from './FundamentalsCard'
import { GeoNewsList, NewsList } from './NewsList'
import { QuoteCard } from './QuoteCard'
import { ReasoningBlock } from './ReasoningBlock'
import { SpecialistStartChip, SpecialistToolCallChip, ToolCallChip } from './ToolCallChip'

export function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user_message':
      return <div className="row user">{item.text}</div>

    case 'assistant_result':
      return (
        <div className="row assistant">
          {item.text && <p className="assistant-text">{item.text}</p>}
          <QuoteCard quotes={item.quotes} />
          <NewsList articles={item.articles} />
          <GeoNewsList articles={item.geoArticles} />
          <FundamentalsCard fundamentals={item.fundamentals} />
          {item.analysis && <AnalysisView analysis={item.analysis} />}
        </div>
      )

    case 'streaming_text':
      return (
        <div className="row assistant">
          <p className="assistant-text">{item.text}</p>
        </div>
      )

    case 'quote_result':
      return (
        <div className="row assistant">
          <QuoteCard quotes={item.quotes} missing={item.missing} />
        </div>
      )

    case 'analysis_result':
      return (
        <div className="row assistant">
          <AnalysisView analysis={item.analysis} />
        </div>
      )

    case 'tool_call':
      return <ToolCallChip name={item.name} args={item.args} />

    case 'specialist_start':
      return <SpecialistStartChip name={item.name} />

    case 'specialist_tool_call':
      return <SpecialistToolCallChip agent={item.agent} name={item.name} args={item.args} />

    case 'reasoning':
      return <ReasoningBlock item={item} />

    case 'error':
      return <div className="row error">✗ {item.message}</div>

    case 'notice':
      return <div className="row notice">{item.text}</div>

    default:
      return null
  }
}
