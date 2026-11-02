# Build contract artifacts
   anchor build
   
   # Synchronize program ID
   anchor keys sync
   
   # Deploy to network
   solana program deploy target/deploy/multihopper.so --keypair /path/to/deployer-keypair.json --url https://api.devnet.solana.com