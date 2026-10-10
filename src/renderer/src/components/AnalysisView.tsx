import type { AnalysisResult } from '../../../shared/types'

export function AnalysisView({ analysis }: { analysis: AnalysisResult }) {
  return (
    <div className="card analysis-grid">
      <div className="panel panel-verdict">
        <div className="panel-title">Risk assessment</div>
        <p>{analysis.verdictText}</p>
        <p className="disclaimer">
          A framework for your own decision, not personalized financial advice.
        </p>
      </div>
    </div>
  )
}
