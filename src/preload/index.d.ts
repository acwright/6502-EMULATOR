import { ElectronAPI } from '@electron-toolkit/preload'
import type { AppApi } from '../shared/api'

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}
