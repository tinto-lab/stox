import path from 'node:path'
import { app } from 'electron'

export interface BackendCommand {
  command: string
  args: string[]
  cwd: string
}

/**
 * Dev: spawn the repo's own .venv Python against stox_bridge.py, from the
 * repo root, so config.load_env()'s repo-relative `.env` lookup still
 * works exactly as it does for the CLI. __dirname at runtime is
 * macapp/out/main, so the repo root is three levels up.
 *
 * Packaged: spawn the PyInstaller-built backend bundled under
 * Contents/Resources/backend (see macapp/package.json's build.extraResources
 * and the Phase 3 packaging script) -- no system Python required.
 *
 * `extraArgs` picks another mode of the same entry point, e.g. `--monitor`
 * for the news monitor loop (see stox_bridge.py).
 */
export function resolveBackendCommand(...extraArgs: string[]): BackendCommand {
  if (app.isPackaged) {
    const backendDir = path.join(process.resourcesPath, 'backend')
    return { command: path.join(backendDir, 'stox-backend'), args: extraArgs, cwd: backendDir }
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  return {
    command: path.join(repoRoot, '.venv', 'bin', 'python3'),
    args: [path.join(repoRoot, 'stox_bridge.py'), ...extraArgs],
    cwd: repoRoot
  }
}
