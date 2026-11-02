// Telemetry & Health Probe snippet integrated into index.ts
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), syncSlot: 284192019 }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(process.env.PORT || 8080);