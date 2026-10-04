import path from 'node:path'
import { loadEnv } from '../core/config'
import { runRepl } from './shell'

/**
 * stox -- the terminal research console (`npm run cli`, or the `npm run
 * build:cli` binary).
 */

// This file sits at src/cli/, so the repo root and its optional .env are two
// levels up. Bun's compiled binary keeps this source path too.
loadEnv(path.resolve(__dirname, '..', '..', '.env'))

async function main(command = ''): Promise<void> {
  const continueLatest = command === '--continue' || command === '-c'
  if (command && !continueLatest) {
    console.error(`unknown command: ${command} -- run stox with no arguments, or --continue to resume the last conversation`)
    process.exitCode = 2
    return
  }
  await runRepl({ continueLatest })
}

void main(process.argv[2])
