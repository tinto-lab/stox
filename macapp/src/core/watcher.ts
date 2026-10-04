import { randomUUID } from 'node:crypto'
import type { AlertDirection, GeoArticle, NewsAlert, NewsMonitor } from '../shared/types'
import { GNewsError, fetchGeoNews } from './gnews'
import { type ChatModel, buildLLM } from './llm'
import { appendAlert, loadAlerts, loadMonitors, loadState, saveState } from './monitors'
import { NotifyError, sendWhatsapp } from './notify'

/**
 * The news monitor loop: polls each monitor's searches, asks the LLM which
 * new headlines matter, and sends an alert for those.
 *
 * One cycle, per monitor (see monitors.ts for what a monitor is):
 *
 * 1. Search Google News (past day) for each of its queries -- headlines
 *    only, no link decoding or article fetching, so a poll stays cheap.
 * 2. Drop headlines it has already seen. A brand-new monitor's first cycle
 *    only records what's already out there ("baseline"), so creating one
 *    doesn't fire a burst of alerts about yesterday's news.
 * 3. If anything is new, one LLM call triages all of it: which headlines
 *    are a material, market-moving development for the goal, and which
 *    tickers that pushes up or down. Recent alerts for the same monitor are
 *    in the prompt, so a story that keeps generating headlines doesn't
 *    alert again unless it escalates.
 * 4. Each alert is logged to alerts.jsonl and sent via WhatsApp. Headlines
 *    are only marked seen once triage succeeds, so an LLM outage delays
 *    alerts rather than dropping them.
 */

const LOOKBACK = 'when:1d'
const PER_QUERY_LIMIT = 10
export const MAX_HEADLINES_PER_TRIAGE = 30
const RECENT_ALERT_WINDOW_SECONDS = 24 * 3600
const DEFAULT_INTERVAL_MINUTES = 10
const MIN_INTERVAL_MINUTES = 2

const DIRECTIONS: AlertDirection[] = ['rise', 'drop', 'watch']
const ARROWS: Record<AlertDirection, string> = { rise: '📈', drop: '📉', watch: '👀' }

export const TRIAGE_SYSTEM =
  'You watch breaking news for a trader and decide what is worth an alert. You get the trader\'s ' +
  'monitoring goal, the tickers they care about, alerts already sent recently, and a numbered list of new ' +
  'headlines. Alert only on material, market-moving developments for the goal: new events, decisions, ' +
  'escalations or de-escalations -- not recaps, explainers, opinion, price commentary, or stories already ' +
  'covered by a recent alert unless they clearly escalate it. Group headlines about the same development ' +
  'into one alert. Most batches deserve no alert at all.\n\n' +
  'For each alert, give `direction` for the goal\'s subject: "rise" or "drop" when the development clearly ' +
  'pushes it that way, "watch" when it\'s significant but the direction is unclear. List the tickers it ' +
  'likely moves under `impacts`, each with its own direction (a tanker stock can rise on the same news that ' +
  "makes airlines drop); use the trader's tickers first and add others only if clearly affected.\n\n" +
  'Reply with JSON only, no prose:\n' +
  '{"alerts": [{"headlines": [1, 4], "direction": "rise", "impacts": [{"ticker": "USO", "direction": "rise"}], ' +
  '"title": "short label for the development", "reason": "one sentence: what happened and why it moves these"}]}\n' +
  'or {"alerts": []} if nothing qualifies.'

/** Google's redirect link is a stable per-article id; the title is only a
 * fallback for an item without one. */
const keyOf = (a: GeoArticle): string => a.link || a.title

/** New articles across all of `monitor`'s queries (deduplicated -- the same
 * story often matches several), plus one message per failed query. */
export async function collectNew(monitor: NewsMonitor, seen: Set<string>): Promise<[GeoArticle[], string[]]> {
  const fresh: GeoArticle[] = []
  const errors: string[] = []
  const keys = new Set<string>()
  const titles = new Set<string>()
  for (const query of monitor.queries) {
    let articles: GeoArticle[]
    try {
      articles = await fetchGeoNews(query, { limit: PER_QUERY_LIMIT, lookback: LOOKBACK, decodeLinks: false })
    } catch (e) {
      if (!(e instanceof GNewsError)) throw e
      errors.push(`monitor ${JSON.stringify(monitor.goal)}, query ${JSON.stringify(query)}: ${e.message}`)
      continue
    }
    for (const a of articles) {
      const key = keyOf(a)
      if (seen.has(key) || keys.has(key) || titles.has(a.title)) continue
      keys.add(key)
      titles.add(a.title)
      fresh.push(a)
    }
  }
  return [fresh, errors]
}

function triagePrompt(monitor: NewsMonitor, articles: GeoArticle[], recent: NewsAlert[]): string {
  const lines = [
    `Goal: ${monitor.goal}`,
    `Tickers: ${monitor.tickers.join(', ') || '(none given)'}`,
    '',
    'Recent alerts already sent:',
    ...(recent.length ? recent.map((a) => `- ${a.title ?? ''}`) : ['(none)']),
    '',
    'New headlines:',
    ...articles.map((a, i) => `[${i + 1}] ${(a.date || '').slice(0, 16)} ${a.title} ${a.summary || ''}`)
  ]
  return lines.join('\n')
}

/** The model's reply as an object, tolerating a code fence or stray prose around it. */
export function parseJsonReply(content: string): Record<string, unknown> {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error("no JSON object in the model's reply")
  return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
}

const direction = (value: unknown): AlertDirection => {
  const v = String(value ?? '').toLowerCase() as AlertDirection
  return DIRECTIONS.includes(v) ? v : 'watch'
}

/** Which of `articles` deserve an alert, as alerts not yet logged or sent.
 * Throws on an LLM or parse failure. */
export async function triage(
  llm: ChatModel,
  monitor: NewsMonitor,
  articles: GeoArticle[],
  now = Math.floor(Date.now() / 1000)
): Promise<NewsAlert[]> {
  const batch = articles.slice(0, MAX_HEADLINES_PER_TRIAGE)
  const recent = loadAlerts(100).filter(
    (a) => a.monitor_id === monitor.id && now - (a.created_at ?? 0) < RECENT_ALERT_WINDOW_SECONDS
  )
  const reply = await llm.complete({
    system: TRIAGE_SYSTEM,
    messages: [{ role: 'user', text: triagePrompt(monitor, batch, recent) }]
  })
  const data = parseJsonReply(reply.text)

  const alerts: NewsAlert[] = []
  for (const item of Array.isArray(data.alerts) ? data.alerts : []) {
    if (!item || typeof item !== 'object') continue
    const picked = (Array.isArray(item.headlines) ? item.headlines : [])
      .filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 1 && (i as number) <= batch.length)
      .map((i: number) => batch[i - 1])
    if (!picked.length) continue
    const impacts = (Array.isArray(item.impacts) ? item.impacts : [])
      .filter((imp: unknown) => imp && typeof imp === 'object' && (imp as { ticker?: unknown }).ticker)
      .map((imp: { ticker: unknown; direction?: unknown }) => ({
        ticker: String(imp.ticker).toUpperCase(),
        direction: direction(imp.direction)
      }))
    alerts.push({
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      monitor_id: monitor.id,
      goal: monitor.goal,
      direction: direction(item.direction),
      impacts,
      title: String(item.title || picked[0].title),
      reason: String(item.reason ?? ''),
      articles: picked.map((a: GeoArticle) => ({ title: a.title, link: a.link, date: a.date })),
      created_at: now,
      delivered: false
    })
  }
  return alerts
}

/** The WhatsApp text for one alert. */
export function formatMessage(alert: NewsAlert): string {
  const lines = [`${ARROWS[alert.direction]} Stox alert: ${alert.title}`]
  if (alert.impacts.length) {
    lines.push(
      alert.impacts
        .map((i) => `${i.ticker} ${i.direction === 'rise' ? '↑' : i.direction === 'drop' ? '↓' : '?'}`)
        .join(' · ')
    )
  }
  if (alert.reason) lines.push(alert.reason)
  lines.push('', ...alert.articles.slice(0, 3).map((a) => `• ${a.title}\n${a.link}`), '', `Monitoring: ${alert.goal}`)
  return lines.join('\n')
}

export interface CycleHooks {
  send?: (text: string) => Promise<void>
  /** Non-fatal problems (a failed query, a failed triage); the cycle goes on. */
  onError?: (message: string) => void
  onAlert?: (alert: NewsAlert) => void
  now?: number
}

/** Checks every monitor once; returns the alerts raised. */
export async function runCycle(llm: ChatModel, hooks: CycleHooks = {}): Promise<NewsAlert[]> {
  const { send = sendWhatsapp, onError, onAlert, now } = hooks
  const monitors = loadMonitors()
  const state = loadState()
  const raised: NewsAlert[] = []

  for (const monitor of monitors) {
    const seen = state[monitor.id]
    const [fresh, errors] = await collectNew(monitor, new Set(seen ?? []))
    errors.forEach((message) => onError?.(message))
    if (seen === undefined) {
      // Baseline: record what's already out there, alert on nothing.
      state[monitor.id] = fresh.map(keyOf)
      continue
    }
    if (!fresh.length) continue

    let alerts: NewsAlert[]
    try {
      alerts = await triage(llm, monitor, fresh, now)
    } catch (e) {
      // Left unseen, so the next cycle triages these again.
      onError?.(`monitor ${JSON.stringify(monitor.goal)}: couldn't triage headlines: ${(e as Error).message}`)
      continue
    }
    seen.push(...fresh.map(keyOf))

    for (const alert of alerts) {
      try {
        await send(formatMessage(alert))
        alert.delivered = true
      } catch (e) {
        if (!(e instanceof NotifyError)) throw e
        alert.delivered = false
        alert.delivery_error = e.message
      }
      appendAlert(alert)
      onAlert?.(alert)
      raised.push(alert)
    }
  }

  saveState(state, new Set(monitors.map((m) => m.id)))
  return raised
}

export function intervalMs(): number {
  const minutes = Number(process.env.STOX_MONITOR_INTERVAL_MIN ?? DEFAULT_INTERVAL_MINUTES)
  return Math.max(Number.isFinite(minutes) ? minutes : DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES) * 60_000
}

export interface WatcherEvents {
  onCycle?: (info: { at: number; monitors: number; alerts: number }) => void
  onError?: (message: string) => void
  onAlert?: (alert: NewsAlert) => void
}

/** Runs cycles every STOX_MONITOR_INTERVAL_MIN minutes until stopped. A
 * cycle never overlaps the next; a failed one is reported and the loop
 * goes on. */
export class Watcher {
  private timer: NodeJS.Timeout | null = null
  private stopped = true

  constructor(private readonly events: WatcherEvents = {}) {}

  get running(): boolean {
    return !this.stopped
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    const started = Date.now()
    if (loadMonitors().length) {
      try {
        const alerts = await runCycle(buildLLM(), {
          onError: this.events.onError,
          onAlert: this.events.onAlert
        })
        this.events.onCycle?.({ at: Math.floor(started / 1000), monitors: loadMonitors().length, alerts: alerts.length })
      } catch (e) {
        this.events.onError?.(`news monitor cycle failed: ${(e as Error).message}`)
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), Math.max(0, intervalMs() - (Date.now() - started)))
  }
}
