# 1. Clone repository and install dependencies
git clone https://github.com/sponsor-org/multihopper-router.git
cd multihopper-router
npm install

# 2. Build Anchor Smart Program
anchor build

# 3. Synchronize program ID across source files
anchor keys sync

# 4. Deploy to Solana Devnet or Mainnet-Beta
anchor deploy --provider.cluster devnet --program-keypair target/deploy/multihopper_router-keypair.json

# 5. Initialize Protocol Global State
ts-node scripts/initialize_protocol.ts --cluster devnet --fee-bps 10