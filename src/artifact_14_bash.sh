# 1. Build Anchor Program
anchor build

# 2. Deploy to Solana Devnet or Mainnet
solana program deploy \
  --program-id target/deploy/multihopper-keypair.json \
  target/deploy/multihopper.so \
  --url https://api.devnet.solana.com

# 3. Run Test Suite with Full Invariant Verification
anchor test

# 4. Spin up Off-Chain Engine & Notifications with Docker
docker-compose up -d --build

# 5. Execute a Multi-Hop Swap via CLI
npx ts-node src/cli.ts execute-route \
  --in-mint So11111111111111111111111111111111111111112 \
  --out-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 1000000 \
  --slippage-bps 30