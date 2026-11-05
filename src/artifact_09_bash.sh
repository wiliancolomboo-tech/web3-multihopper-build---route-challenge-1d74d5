# 1. Build Solana Anchor Program
anchor build

# 2. Sync Program Keys
solana address -k target/deploy/multihopper_router-keypair.json
anchor keys sync

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/multihopper_router-keypair.json \
  target/deploy/multihopper_router.so \
  --url-url https://api.mainnet-beta.solana.com