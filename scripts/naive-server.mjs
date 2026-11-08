// The wrong way, kept only to compare against: the whole file is read into
// memory before the first byte goes out.
//   PORT=3101 FILE=big.ndjson node scripts/naive-server.mjs
import { readFile } from "node:fs/promises";
import http from "node:http";

http
  .createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ rss: process.memoryUsage().rss }));
      return;
    }
    const data = await readFile(process.env.FILE);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.end(data);
  })
  .listen(Number(process.env.PORT), "127.0.0.1");
