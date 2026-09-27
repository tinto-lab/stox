import type { AnalysisResult } from '../protocol'

export function AnalysisView({ analysis }: { analysis: AnalysisResult }) {
  return (
    <div className="card analysis-grid">
      <div className="panel">
        <div className="panel-title">Trend</div>
        <p>{analysis.trend_text}</p>
      </div>
      <div className="panel">
        <div className="panel-title">Fundamentals</div>
        <p>{analysis.fundamentals_text}</p>
      </div>
      <div className="panel">
        <div className="panel-title">News</div>
        <p>{analysis.news_text}</p>
      </div>
      <div className="panel">
        <div className="panel-title">Geopolitics</div>
        <p>{analysis.geopolitics_text}</p>
      </div>
      <div className="panel panel-verdict">
        <div className="panel-title">Risk assessment</div>
        <p>{analysis.verdict_text}</p>
        <p className="disclaimer">
          A framework for your own decision, not personalized financial advice.
        </p>
      </div>
    </div>
  )
}
