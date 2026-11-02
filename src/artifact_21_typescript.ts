import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => console.log("[Healthcheck] Listening on :8080"));