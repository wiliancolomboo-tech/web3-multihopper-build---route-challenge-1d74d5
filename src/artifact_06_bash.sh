# 1. Install dependencies
yarn install

# 2. Build Anchor binary with deterministic build flags
anchor build

# 3. Synchronize program ID across source code and Anchor.toml
solana address -k target/deploy/multi_hopper-keypair.json
# Ensure ID matches declare_id!() in lib.rs

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run full automated integration QA test suite
anchor test