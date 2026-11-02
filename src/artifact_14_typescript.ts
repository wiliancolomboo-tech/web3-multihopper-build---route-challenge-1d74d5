import http from "http";
import { Connection } from "@solana/web3.js";

const PORT = process.env.PORT || 8080;
const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const connection = new Connection(rpcUrl, "confirmed");

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    try {
      const slot = await connection.getSlot("processed");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          clusterSlot: slot,
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
        })
      );
    } catch (err: any) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "unhealthy",
          error: err.message,
        })
      );
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`MultiHopper Telemetry worker listening on port ${PORT}`);
});