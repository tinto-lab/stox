import path from 'node:path'
import { loadEnv } from '../core/config'
import { NotifyError, sendWhatsapp } from '../core/notify'
import { Watcher } from '../core/watcher'
import { runRepl } from './shell'

/**
 * stox -- the terminal research console (`./stox` at the repo root).
 *
 *     stox              the interactive REPL
 *     stox monitor      run the news monitor loop in the foreground (what
 *                       the app does in the background), logging to stdout
 *     stox test-alert   send one WhatsApp test message
 */

// Run from source by tsx, so this file sits at macapp/src/cli/: the repo
// root, and its optional .env, is three levels up.
loadEnv(path.resolve(__dirname, '..', '..', '..', '.env'))

async function main(command = ''): Promise<void> {
  if (command === 'monitor') {
    const log = (text: string): void => console.log(`${new Date().toISOString()} ${text}`)
    new Watcher({
      onCycle: ({ monitors, alerts }) => log(`checked ${monitors} monitor(s), ${alerts} alert(s)`),
      onError: (message) => log(`error: ${message}`),
      onAlert: (alert) => log(`alert: ${alert.title}${alert.delivered ? '' : ` (not delivered: ${alert.delivery_error})`}`)
    }).start()
    return
  }
  if (command === 'test-alert') {
    try {
      await sendWhatsapp('✅ Stox test alert -- WhatsApp alerts are working.')
      console.log('sent.')
    } catch (e) {
      if (!(e instanceof NotifyError)) throw e
      console.error(e.message)
      process.exitCode = 1
    }
    return
  }
  if (command) {
    console.error(`unknown command: ${command} (try: stox, stox monitor, stox test-alert)`)
    process.exitCode = 2
    return
  }
  await runRepl()
}

void main(process.argv[2])
