import { beforeEach, describe, expect, it, vi } from 'vitest'
import { data } from './mocks'
import { stripVTControlCharacters } from 'node:util'
import {
  fmtVolume,
  panel,
  showAnalysis,
  showFundamentals,
  showGeoNews,
  showNews,
  showPriceHistory,
  showQuote,
  showQuotesCompact,
  table,
  wrap
} from '../src/cli/render'
import { ReasoningPrinter } from '../src/cli/reasoning'
import { Shell } from '../src/cli/shell'
import { addConsideration } from '../src/core/considerations'
import { article, bar, fundamentals, geoArticle, quote } from './helpers'

const plain = (s: string): string => stripVTControlCharacters(s)

describe('rendering', () => {
  it('formats volume compactly', () => {
    expect(fmtVolume(1_234_567_890)).toBe('1.2B')
    expect(fmtVolume(50_000_000)).toBe('50.0M')
    expect(fmtVolume(1500)).toBe('1.5K')
    expect(fmtVolume(999)).toBe('999')
  })

  it('aligns table columns, right-aligning the ones asked for', () => {
    expect(table([['a', '1'], ['bbb', '22']], { right: [1] })).toBe('a     1\nbbb  22')
  })

  it('wraps text at word boundaries, keeping line breaks', () => {
    expect(wrap('one two three four\nfive', 9)).toEqual(['one two', 'three', 'four', 'five'])
  })

  it('draws a titled panel around wrapped text', () => {
    const lines = plain(panel('hello world', 'trend')).split('\n')
    expect(lines[0]).toMatch(/^╭─ trend ─+╮$/)
    expect(lines[1]).toMatch(/^│ hello world\s+│$/)
    expect(lines.at(-1)).toMatch(/^╰─+╯$/)
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1)
  })

  it('shows one quote in detail, several compactly', () => {
    const one = plain(showQuote(quote()))
    expect(one).toContain('AAPL')
    expect(one).toContain('227.14   ▲ +3.04  (+1.36%)')
    expect(one).toContain('range  224.50 – 228.00')
    expect(one).toContain('volume 50.0M')
    const many = plain(showQuotesCompact([quote(), { ...quote('TSLA.US'), change: -1, percent: -0.5 }]))
    expect(many).toContain('TSLA.US')
    expect(many).toContain('▼ -1.00')
  })

  it('shows history, fundamentals, news, world news and an analysis', () => {
    expect(plain(showPriceHistory([bar('2026-01-01', 1), bar('2026-01-02', 2)]))).toMatch(/2026-01-02 .* ▲ 2\.00/)
    const f = plain(showFundamentals({ ...fundamentals(), roa: null }))
    expect(f).toContain('AAPL.US  Apple Inc.')
    expect(f).toContain('profit margin +27.62%')
    expect(f).toContain('roa n/a')
    const news = plain(showNews([article()]))
    expect(news).toContain('2026-01-01 ▲ Apple hits new high')
    expect(news).toContain('https://example.com/a')
    expect(plain(showGeoNews([geoArticle()]))).toContain('2026-01-01 TW ▼ Taiwan tightens chip export rules')
    const analysis = plain(
      showAnalysis({
        ticker: 'AAPL',
        trendText: 'T',
        fundamentalsText: 'F',
        newsText: 'N',
        geopoliticsText: 'G',
        verdictText: 'Buy',
        quotes: [],
        bars: [],
        articles: [],
        geoArticles: [],
        fundamentals: null
      })
    )
    for (const title of ['trend', 'fundamentals', 'news', 'geopolitics', 'risk assessment']) expect(analysis).toContain(`─ ${title} `)
    expect(analysis).toContain('not financial advice')
  })

  it('never interprets markup in external text', () => {
    expect(plain(showNews([article('[bold red]gotcha[/] \x1b[31m')]))).toContain('[bold red]gotcha[/]')
  })
})

describe('shell commands', () => {
  let output: string
  beforeEach(() => {
    output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })
    for (const fn of Object.values(data)) fn.mockReset()
  })

  it('/price fetches quotes without the LLM', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: ['NOPE.US'] })
    expect(await new Shell().handleLine('/price aapl nope')).toBe(true)
    expect(data.fetchQuotes).toHaveBeenCalledWith(['aapl', 'nope'])
    expect(plain(output)).toContain('→ quote · AAPL.US, NOPE.US')
    expect(plain(output)).toContain('✗ NOPE.US: no data (unknown symbol?)')
    expect(plain(output)).toContain('227.14')
  })

  it('/price and /analyze need an argument; unknown commands say so', async () => {
    const shell = new Shell()
    await shell.handleLine('/price')
    await shell.handleLine('/analyze')
    await shell.handleLine('/frobnicate')
    expect(plain(output)).toContain('usage: /price <ticker> [...]')
    expect(plain(output)).toContain('usage: /analyze <ticker>')
    expect(plain(output)).toContain('unknown command: /frobnicate')
  })

  it('/considerations lists the stored ones', async () => {
    await new Shell().handleLine('/considerations')
    expect(plain(output)).toContain('no standing considerations yet')
    addConsideration('insider selling')
    await new Shell().handleLine('/remembered')
    expect(plain(output)).toContain('  - insider selling')
  })

  it('a question without a provider key fails cleanly', async () => {
    expect(await new Shell().handleLine("what's apple at?")).toBe(true)
    expect(plain(output)).toContain('✗ no DEEPSEEK_API_KEY set')
  })

  it('/think shows and switches thinking mode for DeepSeek only', async () => {
    process.env.STOX_LLM_PROVIDER = 'openai'
    await new Shell().handleLine('/think on')
    expect(plain(output)).toContain("can't be switched for provider 'openai'")
    process.env.STOX_LLM_PROVIDER = 'deepseek'
    const shell = new Shell()
    await shell.handleLine('/think')
    expect(plain(output)).toContain('thinking mode: off')
    await shell.handleLine('/think on')
    expect(plain(output)).toContain('thinking mode: on')
    expect(process.env.STOX_LLM_THINKING).toBe('on')
    await shell.handleLine('/think sideways')
    expect(plain(output)).toContain('usage: /think [on|off]')
  })

  it('/quit and /exit leave', async () => {
    expect(await new Shell().handleLine('/quit')).toBe(false)
    expect(await new Shell().handleLine('/EXIT')).toBe(false)
  })
})

describe('ReasoningPrinter', () => {
  const printer = () => {
    let out = ''
    return { r: new ReasoningPrinter((t) => (out += t)), text: () => plain(out) }
  }

  it("streams the chat agent's reasoning under a label, and closes it before other output", () => {
    const { r, text } = printer()
    r.step()
    r.delta('The user wants ')
    r.delta('a quote.')
    r.line('  ↳ get_stock_quote()')
    r.step()
    r.delta('Now answer.')
    r.end()
    expect(text()).toBe('  thinking… The user wants a quote.\n  ↳ get_stock_quote()\n  thinking… Now answer.\n')
  })

  it('word-wraps a long stream at the terminal width', () => {
    const { r, text } = printer()
    r.delta(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '))
    r.end()
    const lines = text().trimEnd().split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100)
    expect(lines.slice(1).every((l) => l.startsWith('  '))).toBe(true)
  })

  it('prints each specialist as a whole labelled block, never interleaved', () => {
    const { r, text } = printer()
    r.agentDelta('trend', 'Bars show ')
    r.agentDelta('news', 'Headlines are ')
    r.agentDelta('trend', 'an uptrend.')
    r.agentDelta('news', 'mixed.')
    r.agentStep('trend') // trend's next model call: its first block is done
    r.end()
    expect(text()).toBe('  [trend] thought 1s: Bars show an uptrend.\n  [news] thought 1s: Headlines are mixed.\n')
  })
})
