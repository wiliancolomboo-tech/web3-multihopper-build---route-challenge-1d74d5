#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "    MULTI-HOPPER SOLANA PROTOCOL DEPLOYMENT SCRIPT        "
echo "=========================================================="

export ANCHOR_WALLET="${HOME}/.config/solana/id.json"
export SOLANA_NETWORK="devnet" # Change to "mainnet-beta" for production

echo "[1/4] Building Anchor MultiHopper Program..."
anchor build

PROGRAM_ID=$(solana address -k target/deploy/multi_hopper-keypair.json)
echo "Target Program ID: ${PROGRAM_ID}"

echo "[2/4] Deploying to Solana ${SOLANA_NETWORK}..."
solana program deploy \
  --program-id target/deploy/multi_hopper-keypair.json \
  target/deploy/multi_hopper.so \
  --url "${SOLANA_NETWORK}"

echo "[3/4] Exporting IDL to Client Package..."
cp target/idl/multi_hopper.json cli/src/idl/

echo "[4/4] Verifying Deployment..."
solana program show "${PROGRAM_ID}" --url "${SOLANA_NETWORK}"

echo "SUCCESS: MultiHopper deployed and ready for multi-hop liquidity routing."