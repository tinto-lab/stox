import { buildLLM, type ChatModel } from './llm'

const SYSTEM = `You clean up speech-to-text output. The user dictated a message; fix likely recognition errors (misheard words, stock tickers and company names), add proper punctuation and capitalization, and drop filler words and false starts. Keep the speaker's meaning, wording and language -- never translate, answer, or add anything. Reply with the corrected text only.`

/** Cleans up a dictated transcript with the configured chat model. Falls
 * back to the raw text if the model returns nothing. */
export async function polishTranscript(text: string, model: ChatModel = buildLLM({ thinking: false })): Promise<string> {
  const raw = text.trim()
  if (!raw) return text
  const reply = await model.complete({ system: SYSTEM, messages: [{ role: 'user', text: raw }] })
  return reply.text.trim() || raw
}
