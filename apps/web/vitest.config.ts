import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Virtual PWA register module — stubbed out during tests since the
      // real module is injected by the vite-plugin-pwa build plugin. Tests
      // mock this stub via `vi.mock('virtual:pwa-register')`.
      'virtual:pwa-register': path.resolve(__dirname, './src/test/stubs/pwa-register.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    css: false,
  },
})
