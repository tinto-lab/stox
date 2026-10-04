import { beforeEach, describe, expect, it, vi } from 'vitest'
import { data } from './mocks'
import { addMonitor, appendAlert, loadAlerts, loadState, removeMonitor } from '../src/core/monitors'
import { NotifyError } from '../src/core/notify'
import { GNewsError } from '../src/core/gnews'
import { TRIAGE_SYSTEM, formatMessage, intervalMs, parseJsonReply, runCycle, triage } from '../src/core/watcher'
import type { NewsAlert, NewsMonitor } from '../src/shared/types'
import { FakeLLM, geoArticle, say } from './helpers'

let monitor: NewsMonitor
const NOW = 1_800_000_000

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset()
  monitor = addMonitor('oil up', ['Iran', 'OPEC'], ['USO', 'FRO'])
})

const headlines = (...titles: string[]) => titles.map((t) => geoArticle(t, `https://news.google.com/rss/articles/${t}`))
const reply = (alerts: unknown[]) => say(JSON.stringify({ alerts }))
const send = vi.fn(async (_text: string) => undefined)

async function baseline(...titles: string[]): Promise<void> {
  data.fetchGeoNews.mockResolvedValue(headlines(...titles))
  await runCycle(new FakeLLM([]), { send })
}

describe('runCycle', () => {
  beforeEach(() => send.mockReset())

  it("treats a new monitor's first cycle as a silent baseline", async () => {
    const llm = new FakeLLM([])
    data.fetchGeoNews.mockResolvedValue(headlines('old news'))
    expect(await runCycle(llm, { send })).toEqual([])
    expect(llm.requests).toEqual([])
    expect(loadState()[monitor.id]).toEqual(['https://news.google.com/rss/articles/old news'])
    expect(data.fetchGeoNews).toHaveBeenCalledWith('Iran', { limit: 10, lookback: 'when:1d', decodeLinks: false })
  })

  it('triages new headlines, then alerts, logs and marks them seen', async () => {
    await baseline('old news')
    data.fetchGeoNews.mockResolvedValue(headlines('old news', 'Tanker seized in Hormuz', 'Explainer: oil'))
    const llm = new FakeLLM([
      reply([
        {
          headlines: [1],
          direction: 'rise',
          impacts: [{ ticker: 'uso', direction: 'rise' }, { ticker: 'DAL', direction: 'drop' }],
          title: 'Hormuz tanker seizure',
          reason: 'Supply risk.'
        }
      ])
    ])
    const onAlert = vi.fn()
    const raised = await runCycle(llm, { send, onAlert, now: NOW })

    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({
      monitor_id: monitor.id,
      goal: 'oil up',
      direction: 'rise',
      impacts: [{ ticker: 'USO', direction: 'rise' }, { ticker: 'DAL', direction: 'drop' }],
      title: 'Hormuz tanker seizure',
      reason: 'Supply risk.',
      created_at: NOW,
      delivered: true
    })
    expect(raised[0].articles.map((a) => a.title)).toEqual(['Tanker seized in Hormuz'])
    expect(send).toHaveBeenCalledWith(formatMessage(raised[0]))
    expect(onAlert).toHaveBeenCalledWith(raised[0])
    expect(loadAlerts()).toEqual(raised)
    expect(loadState()[monitor.id]).toHaveLength(3)

    const prompt = (llm.requests[0].messages[0] as { text: string }).text
    expect(llm.requests[0].system).toBe(TRIAGE_SYSTEM)
    expect(prompt).toContain('Goal: oil up\nTickers: USO, FRO')
    expect(prompt).toContain('[1] 2026-01-01T12:00 Tanker seized in Hormuz')
    expect(prompt).not.toContain('old news')
  })

  it('skips the model when nothing is new, and dedupes across queries', async () => {
    await baseline('a')
    const llm = new FakeLLM([reply([])])
    data.fetchGeoNews.mockResolvedValue(headlines('a'))
    await runCycle(llm, { send })
    expect(llm.requests).toHaveLength(0)

    data.fetchGeoNews.mockResolvedValue(headlines('a', 'b'))
    await runCycle(llm, { send })
    expect((llm.requests[0].messages[0] as { text: string }).text.match(/\] /g)).toHaveLength(1)
  })

  it('leaves headlines unseen when triage fails, so the next cycle retries them', async () => {
    await baseline('a')
    data.fetchGeoNews.mockResolvedValue(headlines('a', 'b'))
    const onError = vi.fn()
    await runCycle(new FakeLLM([say('not json')]), { send, onError })
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/couldn't triage headlines/))
    expect(loadState()[monitor.id]).toHaveLength(1)
  })

  it('still logs an alert it could not deliver', async () => {
    await baseline()
    data.fetchGeoNews.mockResolvedValue(headlines('b'))
    send.mockRejectedValueOnce(new NotifyError('not set up'))
    const [alert] = await runCycle(new FakeLLM([reply([{ headlines: [1], title: 't' }])]), { send })
    expect(alert).toMatchObject({ delivered: false, delivery_error: 'not set up' })
    expect(loadAlerts()).toHaveLength(1)
  })

  it('reports a failed query and still runs the others', async () => {
    await baseline()
    data.fetchGeoNews.mockImplementation(async (query: string) => {
      if (query === 'Iran') throw new GNewsError('HTTP 503')
      return headlines('b')
    })
    const onError = vi.fn()
    await runCycle(new FakeLLM([reply([])]), { send, onError })
    expect(onError).toHaveBeenCalledWith('monitor "oil up", query "Iran": HTTP 503')
    expect(loadState()[monitor.id]).toHaveLength(1)
  })

  it("drops a deleted monitor's state", async () => {
    await baseline('a')
    removeMonitor(monitor.id)
    await runCycle(new FakeLLM([]), { send })
    expect(loadState()).toEqual({})
  })
})

describe('triage', () => {
  it('puts recent alerts for the same monitor in the prompt', async () => {
    appendAlert({ monitor_id: monitor.id, title: 'Earlier seizure', created_at: NOW - 3600 } as NewsAlert)
    appendAlert({ monitor_id: monitor.id, title: 'Too old', created_at: NOW - 2 * 86400 } as NewsAlert)
    appendAlert({ monitor_id: 'other', title: 'Not ours', created_at: NOW } as NewsAlert)
    const llm = new FakeLLM([reply([])])
    await triage(llm, monitor, headlines('x'), NOW)
    const prompt = (llm.requests[0].messages[0] as { text: string }).text
    expect(prompt).toContain('Recent alerts already sent:\n- Earlier seizure\n\nNew headlines:')
  })

  it('tolerates fences and prose, and drops malformed items', async () => {
    const llm = new FakeLLM([
      say(
        'Sure!\n```json\n' +
          JSON.stringify({
            alerts: [
              { headlines: [9], title: 'out of range' },
              'garbage',
              { headlines: [2], direction: 'sideways', impacts: [{ direction: 'rise' }, { ticker: 'xom' }] }
            ]
          }) +
          '\n```'
      )
    ])
    const alerts = await triage(llm, monitor, headlines('one', 'two'), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      direction: 'watch',
      impacts: [{ ticker: 'XOM', direction: 'watch' }],
      title: 'two',
      reason: ''
    })
  })

  it('throws on a reply with no JSON', async () => {
    await expect(triage(new FakeLLM([say('nothing to report')]), monitor, headlines('x'))).rejects.toThrow(/no JSON/)
    expect(() => parseJsonReply('{"alerts": []}')).not.toThrow()
  })
})

describe('formatting and settings', () => {
  it('formats the WhatsApp message', () => {
    const text = formatMessage({
      id: 'x',
      monitor_id: 'm',
      goal: 'oil up',
      direction: 'rise',
      impacts: [{ ticker: 'USO', direction: 'rise' }, { ticker: 'DAL', direction: 'drop' }, { ticker: 'X', direction: 'watch' }],
      title: 'Hormuz seizure',
      reason: 'Supply risk.',
      articles: [{ title: 'Tanker seized', link: 'https://r.com/1', date: '' }],
      created_at: 0,
      delivered: false
    })
    expect(text).toBe(
      '📈 Stox alert: Hormuz seizure\nUSO ↑ · DAL ↓ · X ?\nSupply risk.\n\n• Tanker seized\nhttps://r.com/1\n\nMonitoring: oil up'
    )
  })

  it('reads the poll interval from the environment, with a floor', () => {
    expect(intervalMs()).toBe(10 * 60_000)
    process.env.STOX_MONITOR_INTERVAL_MIN = '5'
    expect(intervalMs()).toBe(5 * 60_000)
    process.env.STOX_MONITOR_INTERVAL_MIN = '0.5'
    expect(intervalMs()).toBe(2 * 60_000)
    process.env.STOX_MONITOR_INTERVAL_MIN = 'often'
    expect(intervalMs()).toBe(10 * 60_000)
  })
})
