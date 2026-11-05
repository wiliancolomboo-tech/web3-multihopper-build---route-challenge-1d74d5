// healthcheck server snippet included in daemon runtime
import * as http from 'http';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'HEALTHY', timestamp: Date.now() }));
  } else if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime_seconds: process.uptime(),
      memory_rss_bytes: process.memoryUsage().rss
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080);