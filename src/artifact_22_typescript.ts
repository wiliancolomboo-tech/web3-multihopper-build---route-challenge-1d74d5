// Add to client router service worker
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    const health = {
      status: "HEALTHY",
      uptime: process.uptime(),
      timestamp: Date.now(),
      version: "1.0.0",
      memoryUsage: process.memoryUsage()
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => {
  console.log("MultiHopper Healthcheck endpoint listening on :8080/healthz");
});