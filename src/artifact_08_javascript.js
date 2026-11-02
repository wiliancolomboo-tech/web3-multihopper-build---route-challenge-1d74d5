const http = require("http");

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "HEALTHY",
        uptime: process.uptime(),
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      })
    );
  }
  res.writeHead(404);
  res.end();
});

server.listen(8080, () => {
  console.log("[Healthcheck] HTTP Server listening on port 8080");
});