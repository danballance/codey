import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    // The shared workspace packages and their pure-JS codec dependency ship as
    // one main-process bundle; only Electron and Node built-ins stay external.
    build: { externalizeDeps: false }
  },
  preload: {
    // Sandboxed preloads cannot load arbitrary CommonJS dependencies. Keeping
    // this as one CJS bundle leaves only Electron's permitted API external.
    build: { externalizeDeps: false }
  },
  renderer: {}
})
