import { describe, expect, it } from 'vitest'
import { polishTranscript } from '../src/core/polish'
import type { ChatModel, CompletionRequest } from '../src/core/llm'

const modelReplying = (text: string, seen: CompletionRequest[] = []): ChatModel => ({
  name: 'fake/model',
  async complete(request) {
    seen.push(request)
    return { role: 'assistant', text, toolCalls: [] }
  }
})

describe('polishTranscript', () => {
  it('sends the transcript and returns the cleaned reply', async () => {
    const seen: CompletionRequest[] = []
    const out = await polishTranscript('um what is apple stock doing', modelReplying('  What is Apple stock doing?\n', seen))
    expect(out).toBe('What is Apple stock doing?')
    expect(seen[0].messages).toEqual([{ role: 'user', text: 'um what is apple stock doing' }])
  })

  it('keeps the raw text when the model returns nothing', async () => {
    expect(await polishTranscript('hello there', modelReplying('  '))).toBe('hello there')
  })

  it('skips the model for empty input', async () => {
    const seen: CompletionRequest[] = []
    await polishTranscript('  ', modelReplying('x', seen))
    expect(seen).toHaveLength(0)
  })
})
