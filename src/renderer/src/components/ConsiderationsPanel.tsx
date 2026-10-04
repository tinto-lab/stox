import { useState } from 'react'

export function ConsiderationsPanel({
  considerations,
  onAdd,
  onRemove,
  onClose
}: {
  considerations: string[]
  onAdd: (text: string) => void
  onRemove: (text: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')

  return (
    <div className="panel-overlay">
      <div className="panel-sheet">
        <div className="panel-sheet-header">
          <h2>Standing considerations</h2>
          <button onClick={onClose}>close</button>
        </div>
        <p className="panel-sheet-hint">
          Factors the agent always weighs when explaining a price move or assessing risk, saved to
          ~/.config/stox/considerations.txt and applied to every future session.
        </p>
        <ul className="considerations-list">
          {considerations.map((text) => (
            <li key={text}>
              <span>{text}</span>
              <button onClick={() => onRemove(text)}>remove</button>
            </li>
          ))}
          {considerations.length === 0 && <li className="empty">nothing remembered yet</li>}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim()) return
            onAdd(draft.trim())
            setDraft('')
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. always mention insider selling"
          />
          <button type="submit">add</button>
        </form>
      </div>
    </div>
  )
}
