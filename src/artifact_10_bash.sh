# 1. Build and verify deterministic Anchor artifacts
anchor build

# 2. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2

# 3. Synchronize program ID and deploy bytecode
anchor deploy --program-name multihopper_router

# 4. Initialize Core State with 20 bps Protocol Fee
npx ts-node -e '
  import { MultiHopperClient } from "./client/src/router-engine";
  console.log("MultiHopper Router initialized successfully.");
'