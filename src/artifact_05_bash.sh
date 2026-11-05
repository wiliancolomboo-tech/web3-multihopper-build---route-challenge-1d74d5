# 1. Install dependencies and compile Solana programs
anchor build

# 2. Sync keys and verify PDA program addresses
solana address -k target/deploy/multihopper-keypair.json

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/multihopper-keypair.json \
  target/deploy/multihopper.so \
  --url https://api.mainnet-beta.solana.com \
  --keypair ~/.config/solana/id.json

# 4. Initialize Program Configuration
npx ts-node cli/init-router.ts \
  --fee-bps 100 \
  --rev-share-bps 3000 \
  --treasury <TREASURY_PUBKEY>