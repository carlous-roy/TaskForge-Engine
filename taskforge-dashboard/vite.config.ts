import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Two editions come out of this one source tree.
//
// The service edition (the default) is what the API serves at "/": the build lands in
// target/classes/static, which the Maven jar plugin packages and Spring Boot serves from the
// classpath root, and the page talks to /api/v1 (proxied to a local API in development).
//
// VITE_DEMO=1 builds the browser edition for the hosted page: no API is called; the console drives
// the simulator in src/sim, which runs the service's rules with the service's constants in the tab.
// Its output goes to dist, where Vercel expects it.
const browserEdition = process.env.VITE_DEMO === '1'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: browserEdition ? 'dist' : 'target/classes/static',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
