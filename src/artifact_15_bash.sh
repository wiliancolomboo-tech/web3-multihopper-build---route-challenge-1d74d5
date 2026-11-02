# 1. Clone & Configure Environment
git clone https://github.com/multihopper/multihopper-core.git
cd multihopper-core
cp .env.example .env

# 2. Build Solana Programs
anchor build

# 3. Deploy MultiHopper Engine on Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name multi_hopper --provider.cluster devnet

# 4. Initialize Config PDA & Revenue Sharing Authority
npm run ts-node src/scripts/initialize.ts \
  --fee-bps 20 \
  --treasury-split 8000 \
  --treasury <YOUR_TREASURY_PUBKEY>

# 5. Run Full End-to-End Test Suite
anchor test --skip-local-validator