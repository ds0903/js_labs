import { defineConfig } from "vite";

const backend = process.env.BACKEND ?? "127.0.0.1:3000";

// Dev only: /slow/<ms>/<path> answers with <path> after <ms> milliseconds,
// to test the loading screen with slow and hanging requests.
function slowAssets() {
  return {
    name: "slow-assets",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const match = req.url.match(/^\/slow\/(\d+)(\/.*)$/);
        if (!match) return next();
        req.url = match[2];
        setTimeout(next, Number(match[1]));
      });
    },
  };
}

export default defineConfig({
  plugins: [slowAssets()],
  // the page and the API share one origin in dev, as they do in production
  server: {
    proxy: {
      "/api": `http://${backend}`,
      "/health": `http://${backend}`,
      "/ws": { target: `ws://${backend}`, ws: true },
    },
  },
});
