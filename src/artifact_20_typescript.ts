import express, { Request, Response } from 'express';
import { logger } from './logger';

const app = express();
const PORT = process.env.PORT || 8080;

let isHealthy = true;
let totalSwapsRouted = 0;
let totalVolumeBaseUnits = BigInt(0);

app.use(express.json());

app.get('/healthz', (req: Request, res: Response) => {
  if (isHealthy) {
    return res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
  }
  return res.status(503).json({ status: 'DOWN' });
});

app.get('/metrics', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(`
# HELP multihopper_swaps_total Total number of swaps routed
# TYPE multihopper_swaps_total counter
multihopper_swaps_total ${totalSwapsRouted}

# HELP multihopper_volume_total Total volume routed in base units
# TYPE multihopper_volume_total counter
multihopper_volume_total ${totalVolumeBaseUnits.toString()}
  `);
});

app.listen(PORT, () => {
  logger.info(`MultiHopper Telemetry & Router Server running on port ${PORT}`);
});