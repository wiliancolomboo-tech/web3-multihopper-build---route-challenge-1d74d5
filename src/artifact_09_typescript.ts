import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { MultiHopperClient } from "./router";
import { TelemetryService } from "./telemetry";

dotenv.config();

const program = new Command();

program
  .name("multihopper-cli")
  .description("Enterprise MultiHopper Build & Route Automation Engine")
  .version("1.0.0");

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

program
  .command("execute")
  .description("Execute multi-hop routing swap")
  .requiredOption("-s, --source <pubkey>", "Source Token Mint")
  .requiredOption("-d, --dest <pubkey>", "Destination Token Mint")
  .requiredOption("-a, --amount <number>", "Amount in base units")
  .requiredOption("-m, --min-out <number>", "Minimum acceptable output units")
  .option("-r, --referral <pubkey>", "Referral ATA for revenue share")
  .option("-b, --ref-bps <number>", "Referral BPS share (0-10000)", "2000")
  .option("-k, --keypair <path>", "Path to Solana secret keypair", "./id.json")
  .action(async (opts) => {
    const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
    const programId = new PublicKey(
      process.env.ROUTER_PROGRAM_ID || "HopR7s8TzE3zW1nZq1uM9P4a5S6d7F8g9H0j1K2L3M4"
    );

    const connection = new Connection(rpcUrl, "confirmed");
    const wallet = loadKeypair(opts.keypair);

    const telemetry = new TelemetryService({
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      resendApiKey: process.env.RESEND_API_KEY,
      alertEmailTo: process.env.ALERT_EMAIL_TO,
    });

    console.log(`[MultiHopper] Initializing routing engine via RPC: ${rpcUrl}`);
    console.log(`[MultiHopper] Trader identity: ${wallet.publicKey.toBase58()}`);

    const idl = JSON.parse(
      fs.readFileSync("./target/idl/multihopper_router.json", "utf-8")
    );

    const client = new MultiHopperClient(
      connection,
      wallet,
      programId,
      idl,
      telemetry
    );

    try {
      // Mock 2-hop route: Raydium CP-AMM -> Orca Whirlpool
      const mockHops = [
        {
          targetDexProgram: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // Raydium
          writableAccounts: [],
          readonlyAccounts: [],
          instructionData: Buffer.from([0x01, 0x02]),
        },
      ];

      const signature = await client.executeMultiHopSwap({
        sourceMint: new PublicKey(opts.source),
        destinationMint: new PublicKey(opts.dest),
        amountIn: BigInt(opts.amount),
        minAmountOut: BigInt(opts.minOut),
        referralBps: parseInt(opts.refBps),
        referralTokenAccount: opts.referral ? new PublicKey(opts.referral) : undefined,
        hops: mockHops,
      });

      console.log(`[MultiHopper] Swap finalized successfully! Tx Hash: ${signature}`);
    } catch (err: any) {
      console.error("[MultiHopper] Execution failure:", err);
      process.exit(1);
    }
  });

program.parse(process.argv);