# 1. Build and verify Anchor smart contract
anchor build
anchor test

# 2. Deploy MultiHopper to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/multihopper-keypair.json \
  target/deploy/multihopper.so \
  --url-env devnet

# 3. Spin up turnkey orchestration daemon
docker compose up -d --build
docker compose logs -f multihopper-node