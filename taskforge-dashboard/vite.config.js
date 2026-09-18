import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The build lands in target/classes/static, which the Maven jar plugin packages and Spring Boot
// serves from the classpath root of the API (index.html is the welcome page at "/").
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'target/classes/static',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
