import { defineConfig } from "vite";

/**
 * В dev фронт (Vite) обычно на :5173, бэкенд на :4000.
 * Чтобы socket.io и /audio работали без CORS/таймаутов — проксируем их на бэкенд.
 *
 * При необходимости можно переопределить:
 *   VITE_BACKEND_URL="http://localhost:4000"
 */
const target = process.env.VITE_BACKEND_URL || "http://localhost:4000";

export default defineConfig({
  base: "./",
  server: {
    proxy: {
      "/socket.io": {
        target,
        ws: true,
        changeOrigin: true,
      },
      "/audio": {
        target,
        changeOrigin: true,
      },
      "/health": {
        target,
        changeOrigin: true,
      },
    },
  },
});
