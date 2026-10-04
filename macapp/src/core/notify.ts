/**
 * Alert delivery: WhatsApp via CallMeBot (free, personal-use relay).
 *
 * CallMeBot sends WhatsApp messages to your own number with no business
 * account: message their bot once ("I allow callmebot to send me messages")
 * and it replies with an API key. Configured by two env vars, set from the
 * app's Settings panel or ~/.config/stox/.env like every other key:
 *
 *     CALLMEBOT_PHONE    your number in international format, e.g. +14155550123
 *     CALLMEBOT_APIKEY   the key CallMeBot sent you
 *
 * It's one GET per message and rate-limited on their side, so the watcher
 * sends one message per alert, never per headline.
 */

export const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php'
const REQUEST_TIMEOUT_MS = 20_000
// The text travels in a query string; keep well clear of URL length limits.
export const MAX_MESSAGE_CHARS = 1500

export class NotifyError extends Error {}

export function whatsappConfigured(): boolean {
  return Boolean(process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY)
}

export async function sendWhatsapp(text: string): Promise<void> {
  const phone = (process.env.CALLMEBOT_PHONE ?? '').trim()
  const apikey = (process.env.CALLMEBOT_APIKEY ?? '').trim()
  if (!phone || !apikey) {
    throw new NotifyError("WhatsApp isn't set up -- add CALLMEBOT_PHONE and CALLMEBOT_APIKEY in Settings")
  }
  const params = new URLSearchParams({ phone, apikey, text: text.slice(0, MAX_MESSAGE_CHARS) })
  let response: Response
  try {
    response = await fetch(`${CALLMEBOT_URL}?${params}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (e) {
    throw new NotifyError(`network error: ${(e as Error).message}`)
  }
  // A bad key or unregistered phone comes back as an HTML page that may
  // still be a 200, so the body has to be checked too.
  const body = await response.text().catch(() => '')
  const lower = body.toLowerCase()
  if (response.status !== 200 || lower.includes('invalid') || lower.includes('error')) {
    throw new NotifyError(`CallMeBot rejected the message (HTTP ${response.status}): ${plain(body).slice(0, 200)}`)
  }
}

/** Crude tag strip, just so an error message is readable. */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
