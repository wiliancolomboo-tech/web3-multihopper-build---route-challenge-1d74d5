import http from 'http';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      protocol: 'MultiHopper',
      uptimeSec: process.uptime(),
      timestamp: Date.now()
    }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(8080, () => {
  console.log('[MultiHopper Telemetry] Healthcheck listener running on :8080/healthz');
});