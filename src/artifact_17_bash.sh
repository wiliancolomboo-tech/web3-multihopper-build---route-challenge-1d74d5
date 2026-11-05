# 1. Clone repository & configure environment
git clone https://github.com/multihopper/multihopper-core.git
cd multihopper-core

# 2. Build Anchor deterministic binary
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Initialize Protocol Global State
ts-node scripts/initialize_protocol.ts \
  --admin-keypair ~/.config/solana/id.json \
  --fee-bps 20 \
  --treasury-address <ENTER_TREASURY_SPL_ACCOUNT>