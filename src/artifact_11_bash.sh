# 1. Install Solana CLI & Anchor
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1

# 2. Build On-Chain Program and generate IDL
anchor build

# 3. Synchronize Program ID
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.mainnet-beta.solana.com
solana airdrop 2 || true # If devnet
anchor deploy --program-name multihopper_router --provider.cluster mainnet

# 5. Initialize MultiHopper Global PDAs
ts-node scripts/init-protocol.ts \
  --admin ~/.config/solana/id.json \
  --treasury <TREASURY_PUBKEY> \
  --fee-bps 25