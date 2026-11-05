# 1. Build Solana Program
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/multihopper-keypair.json \
  target/deploy/multihopper.so \
  --url https://api.mainnet-beta.solana.com

# 3. Initialize Protocol Config
yarn ts-node src/cli.ts init-config \
  --fee-bps 30 \
  --rev-share-bps 2000 \
  --treasury <TREASURY_PUBKEY>

# 4. Spin up Docker Engine
docker-compose up -d --build

# 5. Monitor Live Logs & Healthcheck
docker-compose logs -f multihopper-router