# -------------------------------------------------------------
# STEP 1: Smart Contract Build & Keypair Generation
# -------------------------------------------------------------
solana-keygen new --outfile deployer-keypair.json --no-bip39-passphrase
export PROGRAM_ID="HopR7s81UfHj6Nq1W4B3vXvL9wFhM8aB2kP1c7D9uV4"

# Build Rust Anchor BPF Artifact
anchor build

# -------------------------------------------------------------
# STEP 2: Deploy to Solana Devnet / Mainnet-Beta
# -------------------------------------------------------------
solana program deploy \
  --program-id deployer-keypair.json \
  target/deploy/multihopper_router.so \
  --url https://api.mainnet-beta.solana.com

# -------------------------------------------------------------
# STEP 3: Initialize MultiHopper Global State
# -------------------------------------------------------------
yarn ts-node src/cli.ts init-protocol \
  --fee-bps 30 \
  --referrer-cut-bps 2000 \
  --treasury <TREASURY_PUBKEY>

# -------------------------------------------------------------
# STEP 4: Launch Off-Chain Daemon via Docker Compose
# -------------------------------------------------------------
docker-compose up -d --build
docker-compose logs -f multihopper-node