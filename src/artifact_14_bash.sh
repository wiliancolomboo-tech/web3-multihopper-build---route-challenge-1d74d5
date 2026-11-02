# 1. Build and test on-chain Anchor smart contract
cd programs/multihopper_router
cargo build-sbf
anchor test

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/multihopper_router-keypair.json \
  target/deploy/multihopper_router.so \
  --url-rpc https://api.devnet.solana.com

# 3. Launch Dockerized MultiHopper SOR Microservice
docker compose up -d --build

# 4. Verify Engine Healthcheck
curl http://localhost:8080/health
# Response: {"status":"healthy","uptime":3.12,"timestamp":1729000000000,"protocol":"MultiHopper Engine v1.0"}

# 5. Execute sample multi-hop route quote
npx ts-node src/cli.ts quote \
  -i So11111111111111111111111111111111111111112 \
  -o DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 \
  -a 1000000000