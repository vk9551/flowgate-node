import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    // Outputs to dashboard/dist/ at the project root.
    // flowgate-node serves from this path (not internal/dashboard/dist like Go).
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:7700',
        changeOrigin: true,
      },
    },
  },
})
