import http from 'http';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'UP',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        engine: 'MultiHopper Solana v1.0.0',
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[MultiHopper Monitoring] Healthcheck server live on port ${PORT}`);
});