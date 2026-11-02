# Create local credentials directory
mkdir -p credentials
cp ~/.config/solana/id.json ./credentials/id.json

# Populate environment file
cat <<EOF > .env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PROGRAM_ID=HoPz5TqXyQG2aB8m7eNkKk4V5vJ6Y8XW3qZ7m9L2bC4
RESEND_API_KEY=re_123456789
RESEND_ALERT_EMAIL=ops@sponsor-dao.org
SLACK_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/abc
EOF

# Launch turnkey containerized stack
docker-compose up -d --build