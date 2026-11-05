import * as http from "http";

const PORT = process.env.PORT || 8080;

export function startHealthServer(isReadyCallback: () => boolean) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const ready = isReadyCallback();
      if (ready) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "degraded", timestamp: Date.now() }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, () => {
    console.log(`Healthcheck endpoint active on :${PORT}/health`);
  });
}