# 1. Sync Program ID
anchor keys sync

# 2. Build deterministic release binary
cargo build-sbf --manifest-path programs/multihopper_core/Cargo.toml

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/multihopper_core-keypair.json \
  target/deploy/multihopper_core.so \
  --url-url https://api.devnet.solana.com