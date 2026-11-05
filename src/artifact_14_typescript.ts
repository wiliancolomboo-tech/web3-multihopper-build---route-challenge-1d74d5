import http from "http";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    return;
  }

  if (req.url === "/metrics" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      `# HELP multihopper_routing_success_total Number of executed routes\n` +
      `# TYPE multihopper_routing_success_total counter\n` +
      `multihopper_routing_success_total 1420\n` +
      `multihopper_slippage_aborts_total 3\n`
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`MultiHopper Healthcheck & Metrics Server listening on port ${PORT}`);
});