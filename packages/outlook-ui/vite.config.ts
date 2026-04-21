import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const API_PORT = 6877

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 6876,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
      "/outlook/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
