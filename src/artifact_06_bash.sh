# 1. Clone repository and install dependencies
git clone https://github.com/solhop-enterprise/multihopper-router.git
cd multihopper-router
npm install

# 2. Build on-chain Anchor program
anchor build

# 3. Synchronize program ID
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Initialize Protocol State
anchor run init-protocol --provider.cluster devnet