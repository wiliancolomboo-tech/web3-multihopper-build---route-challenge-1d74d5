# 1. Install prerequisites and Anchor 0.30.1
solana-install init 1.18.26
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked

# 2. Build deterministic on-chain binaries
anchor build --verifiable

# 3. Synchronize keys and deploy to Devnet/Mainnet
solana program deploy \
  --program-id target/deploy/multihopper-keypair.json \
  target/deploy/multihopper.so \
  --url https://api.mainnet-beta.solana.com \
  --keypair ~/.config/solana/mainnet-authority.json