import path from 'node:path'
import { loadEnv } from '../core/config'
import { runRepl } from './shell'

/**
 * stox -- the terminal research console (`./stox` at the repo root).
 */

// Run from source by tsx, so this file sits at macapp/src/cli/: the repo
// root, and its optional .env, is three levels up.
loadEnv(path.resolve(__dirname, '..', '..', '..', '.env'))

async function main(command = ''): Promise<void> {
  if (command) {
    console.error(`unknown command: ${command} -- run stox with no arguments`)
    process.exitCode = 2
    return
  }
  await runRepl()
}

void main(process.argv[2])
