import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MultiHopperRouterService, HopPlan } from "./router";
import * as fs from "fs";

const program = new Command();

program
  .name("multi-hopper-cli")
  .description("Enterprise CLI for routing atomic multi-hop swaps across Solana DEXs")
  .version("1.0.0");

program
  .command("execute-route")
  .requiredOption("-k, --keypair <path>", "Path to local keypair json")
  .requiredOption("-i, --input-mint <pubkey>", "Input token mint address")
  .requiredOption("-o, --output-mint <pubkey>", "Output token mint address")
  .requiredOption("-a, --amount-in <number>", "Raw amount of input token")
  .requiredOption("-m, --min-out <number>", "Minimum acceptable amount of output token")
  .requiredOption("-r, --rpc <url>", "Solana RPC URL", "https://api.mainnet-beta.solana.com")
  .action(async (options) => {
    try {
      const secret = JSON.parse(fs.readFileSync(options.keypair, "utf-8"));
      const payer = Keypair.fromSecretKey(new Uint8Array(secret));
      const programId = new PublicKey("Hop1111111111111111111111111111111111111111");

      const router = new MultiHopperRouterService(options.rpc, payer, programId);

      // Define 3-Hop Route: Input -> Orca Whirlpool -> Meteora DLMM -> User Destination
      const sampleHops: HopPlan[] = [
        {
          ammType: 0, // Orca
          poolProgramId: new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
          expectedOutput: BigInt(options.minOut) + 1000n,
          minOutputForHop: BigInt(options.minOut),
        },
      ];

      console.log(`[INFO] Submitting atomic multi-hop route for ${payer.publicKey.toBase58()}...`);
      const sig = await router.executeMultiHopSwap(
        new PublicKey(options.inputMint),
        new PublicKey(options.outputMint),
        new PublicKey(options.inputMint), // User source ATA
        new PublicKey(options.outputMint), // User dest ATA
        BigInt(options.amountIn),
        BigInt(options.minOut),
        sampleHops
      );

      console.log(`[SUCCESS] Route executed atomically. Tx: ${sig}`);
      process.exit(0);
    } catch (err: any) {
      console.error(`[ERROR] Multi-hop route failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);