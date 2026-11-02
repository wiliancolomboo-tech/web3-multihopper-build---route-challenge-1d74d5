# 1. Clone & Setup Workspace
git clone https://github.com/multihopper-protocol/multihopper-core.git
cd multihopper-core

# 2. Build Anchor Program
anchor build

# 3. Synchronize Program ID
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet
anchor deploy --provider.cluster https://api.devnet.solana.com --program-keypair ./target/deploy/multi_hopper-keypair.json

# 5. Initialize Protocol On-Chain Configuration
npm install
npx ts-node cli/admin_init.ts --cluster devnet --fee-bps 30 --default-integrator-share 5000