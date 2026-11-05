import http from "http";

export function startHealthCheckServer(port = 8080) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "UP",
          engine: "MultiHopper Smart Router",
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`Telemetry health check listening on port ${port}`);
  });
}