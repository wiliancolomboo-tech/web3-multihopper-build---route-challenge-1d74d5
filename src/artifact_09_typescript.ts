import http from "http";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "HEALTHY",
        protocol: "MultiHopper Engine",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[Healthcheck] Listening on http://localhost:${PORT}/health`);
});