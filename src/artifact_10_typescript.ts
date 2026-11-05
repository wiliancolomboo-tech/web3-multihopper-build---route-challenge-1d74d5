import * as http from 'http';

const PORT = process.env.METRICS_PORT || 8080;
let isHealthy = true;
let totalSwapsRouted = 0;

export function incrementMetric() {
  totalSwapsRouted++;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isHealthy ? 'UP' : 'DOWN', uptime: process.uptime() }));
  } else if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(
      `# HELP multihopper_swaps_total Total multi-hop swaps executed\n` +
      `# TYPE multihopper_swaps_total counter\n` +
      `multihopper_swaps_total ${totalSwapsRouted}\n`
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Telemetry and healthcheck listening on port ${PORT}`);
});