import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The site is served from the root of orders.atomeats.com
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
})
