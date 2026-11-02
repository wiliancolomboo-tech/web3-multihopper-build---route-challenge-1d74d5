import http from 'http';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: 'multihopper-router-engine',
    }));
  } else if (req.url === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(
      `# HELP multihopper_active_pools Number of tracked liquidity pools\n` +
      `# TYPE multihopper_active_pools gauge\n` +
      `multihopper_active_pools 142\n` +
      `# HELP multihopper_routes_evaluated Total paths scored\n` +
      `# TYPE multihopper_routes_evaluated counter\n` +
      `multihopper_routes_evaluated 18920\n`
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[MultiHopper Health Service] Operational on port ${PORT}`);
});