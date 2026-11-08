import { defineConfig } from "vite";

// Dev only.
// /api/rooms is answered from public/api/rooms.json (lab 4 replaces it with
// a real server), and /slow/<ms>/<path> answers with <path> after <ms>
// milliseconds, to test the loading screen with slow and hanging requests.
function slowAssets() {
  return {
    name: "slow-assets",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/api/rooms") req.url = "/api/rooms.json";
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
});
