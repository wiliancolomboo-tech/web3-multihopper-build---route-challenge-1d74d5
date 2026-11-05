# 1. Setup Solana Environment
solana config set --url https://api.devnet.solana.com
solana airdrop 2 $(solana address)

# 2. Build the MultiHopper Anchor Program
anchor build

# 3. Synchronize Program ID
anchor keys sync

# 4. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 5. Initialize MultiHopper Global Configuration (0.3% base fee, 50% rev-share to partner)
ts-node client/src/index.ts initialize --base-fee 30 --partner-share 5000