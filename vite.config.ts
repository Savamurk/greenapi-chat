import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base задаётся при сборке на GitHub Pages (VITE_BASE=/имя-репозитория/), локально корень
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
})
