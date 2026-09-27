import type { StoxApi } from '../../shared/types'

export {}

declare global {
  interface Window {
    stox: StoxApi
  }
}
