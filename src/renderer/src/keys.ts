import type { KeyboardEvent } from 'react'

/**
 * Whether a key press belongs to an input method still composing text
 * (Zhuyin, Pinyin, Japanese kana, ...): the Enter that picks a candidate,
 * the arrows that move between candidates, the Escape that cancels. Those
 * are the IME's, so a handler should leave them alone. keyCode 229 covers
 * the WebKit order where compositionend arrives before that keydown.
 */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229
}
