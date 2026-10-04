import { useState } from 'react'

const KEY_STEP = 24

/** A vertical drag handle on the left edge of a right-hand panel: dragging
 * left widens the panel. `onResize(width, done)` fires on every move and once
 * more with done=true when the drag (or an arrow-key nudge) ends, so the
 * caller can apply live and persist only the final value. Double-click resets. */
export function ResizeHandle({
  width,
  label,
  onResize,
  onReset
}: {
  width: number
  label: string
  onResize: (width: number, done: boolean) => void
  onReset: () => void
}) {
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const startX = e.clientX
    const startWidth = width
    const widthAt = (clientX: number): number => startWidth + (startX - clientX)

    handle.setPointerCapture(e.pointerId)
    setDragging(true)
    document.body.classList.add('resizing')

    let lastX = startX
    const onMove = (ev: PointerEvent): void => {
      lastX = ev.clientX
      onResize(widthAt(lastX), false)
    }
    // lostpointercapture, not pointerup: it fires after a normal release and
    // also when the drag is cut short some other way (app switch, window
    // blur, cancel), so the drag can't be left stuck in the resizing state.
    const onEnd = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('lostpointercapture', onEnd)
      setDragging(false)
      document.body.classList.remove('resizing')
      onResize(widthAt(lastX), true)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('lostpointercapture', onEnd)
  }

  return (
    <div
      className={`resize-handle ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onResize(width + KEY_STEP, true)
        else if (e.key === 'ArrowRight') onResize(width - KEY_STEP, true)
        else return
        e.preventDefault()
      }}
    />
  )
}
