# Verify environment secrets
cat <<EOF > .env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SIGNER_SECRET_KEY=[1,2,3...]
ROUTER_PROGRAM_ID=MHopRouter1111111111111111111111111111111111
ENTERPRISE_WEBHOOK_URL=https://example.com/webhook/discord-placeholder
EOF

# Launch automated container stack
docker compose up -d --build
docker compose logs -f multihopper-worker