# Set protocol fee to 15 bps (0.15%) and Integrator RevShare to 8000 bps (80%)
npx ts-node scripts/init-protocol.ts \
  --fee 15 \
  --revshare 8000 \
  --treasury <YOUR_TREASURY_PUBKEY>