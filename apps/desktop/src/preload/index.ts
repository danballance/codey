import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  desktopIpc,
  type ConnectOptions,
  type ConnectionStatus,
  type DesktopBridge,
  type EditorSnapshot
} from '../shared/contracts'

function subscribe<T>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const bridge: DesktopBridge = Object.freeze({
  connect: (options: ConnectOptions) => ipcRenderer.invoke(desktopIpc.connect, options),
  disconnect: () => ipcRenderer.invoke(desktopIpc.disconnect),
  input: (keys: string) => ipcRenderer.invoke(desktopIpc.input, keys),
  resize: (columns: number, rows: number) =>
    ipcRenderer.invoke(desktopIpc.resize, { columns, rows }),
  onSnapshot: (listener: (snapshot: EditorSnapshot) => void) =>
    subscribe(desktopIpc.snapshot, listener),
  onStatus: (listener: (status: ConnectionStatus) => void) =>
    subscribe(desktopIpc.status, listener)
})

contextBridge.exposeInMainWorld('codey', bridge)
