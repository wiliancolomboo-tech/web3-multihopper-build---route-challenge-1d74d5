import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MultiHopperClient } from "./router";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();

program
  .name("multihopper-cli")
  .description("MultiHopper Multi-Path Liquidity Aggregator & Route Dispatcher CLI")
  .version("1.0.0");

program
  .command("route")
  .description("Execute multi-hop routing between two SPL tokens")
  .requiredOption("-s, --source <mint>", "Source SPL Mint address")
  .requiredOption("-d, --destination <mint>", "Destination SPL Mint address")
  .requiredOption("-a, --amount <units>", "Raw Input token amount")
  .requiredOption("-m, --min-out <units>", "Minimum guaranteed output amount")
  .option("-k, --keypair <path>", "Path to Solana keypair JSON", "./deployer-keypair.json")
  .option("-r, --rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com")
  .action(async (options) => {
    try {
      console.log("[+] Initializing MultiHopper Automation CLI...");
      const keypairData = JSON.parse(fs.readFileSync(options.keypair, "utf-8"));
      const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

      const programId = new PublicKey(
        process.env.PROGRAM_ID || "MHopRoutEr1111111111111111111111111111111111"
      );

      const client = new MultiHopperClient(options.rpc, keypair, programId);

      console.log(`[+] Wallet: ${keypair.publicKey.toBase58()}`);
      console.log(`[+] Source Mint: ${options.source}`);
      console.log(`[+] Target Mint: ${options.destination}`);
      console.log(`[+] In Amount: ${options.amount} | Min Out: ${options.minOut}`);

      // Assemble mock 2-hop sequence for demo/execution test
      const dummyHopProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const hops = [
        {
          targetProgram: dummyHopProgram,
          accounts: [],
          instructionData: Buffer.alloc(0),
        },
      ];

      const sig = await client.executeRoute({
        sourceMint: new PublicKey(options.source),
        destinationMint: new PublicKey(options.destination),
        amountIn: BigInt(options.amount),
        minAmountOut: BigInt(options.minOut),
        hops,
      });

      console.log(`[SUCCESS] Route executed atomically! Tx: ${sig}`);
    } catch (err: any) {
      console.error(`[ERROR] Routing execution failure: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);