# 1. Clone repository & install dependencies
git clone https://github.com/multihopper-protocol/multihopper-core.git
cd multihopper-core
npm install

# 2. Build on-chain Anchor smart contract
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet
anchor deploy --provider.cluster devnet

# 5. Initialize Protocol via Automation Client
ts-node src/cli.ts execute-route \
  --keypair ~/.config/solana/id.json \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount-in 1000000000 \
  --min-out 145000000 \
  --rpc https://api.devnet.solana.com