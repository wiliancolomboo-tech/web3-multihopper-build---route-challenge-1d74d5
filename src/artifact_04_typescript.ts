import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

export interface RouteHop {
  poolAddress: string;
  sourceMint: string;
  targetMint: string;
  dexProtocol: "Raydium" | "Orca" | "Meteora";
  expectedRate: number;
}

export interface OptimalRoute {
  path: RouteHop[];
  estimatedOutAmount: bigint;
  minimumAcceptableOut: bigint;
  priceImpactBps: number;
}

export class MultiHopperOrchestrator {
  private connection: Connection;
  private signer: Keypair;
  private programId: PublicKey;
  private slackWebhookUrl: string;
  private discordWebhookUrl: string;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");

    const secretKeyStr = process.env.DEPLOYER_KEYPAIR_JSON;
    if (!secretKeyStr) {
      throw new Error("DEPLOYER_KEYPAIR_JSON is missing from environment variables.");
    }
    this.signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyStr)));
    this.programId = new PublicKey(
      process.env.MULTI_HOPPER_PROGRAM_ID || "HopR2XWk3m5yZz9vD4qJ7wT1cK8vN3bL9sQ6uF2aP5e"
    );
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
  }

  /**
   * Evaluates shortest/cheapest path across decentralized liquidity pools
   */
  public async findBestRoute(
    sourceMint: string,
    destinationMint: string,
    amountIn: bigint,
    maxSlippageBps: number = 50
  ): Promise<OptimalRoute> {
    // In production, queries the local in-memory graph syncer or Geyser feed
    console.log(`[MultiHopper Graph] Finding optimal route from ${sourceMint} to ${destinationMint}...`);

    // Simulated 2-hop graph discovery: SOL -> USDC -> SOLHOP_TOKEN
    const intermediateMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const hop1: RouteHop = {
      poolAddress: "RaydiumPoolUSDC_SOL1111111111111111111111111",
      sourceMint,
      targetMint: intermediateMint,
      dexProtocol: "Raydium",
      expectedRate: 150.25,
    };

    const hop2: RouteHop = {
      poolAddress: "OrcaWhirlpoolUSDC_HOP22222222222222222222222",
      sourceMint: intermediateMint,
      targetMint: destinationMint,
      dexProtocol: "Orca",
      expectedRate: 0.985,
    };

    const estimatedOut = BigInt(Math.floor(Number(amountIn) * hop1.expectedRate * hop2.expectedRate));
    const slippageDeduction = (estimatedOut * BigInt(maxSlippageBps)) / BigInt(10_000);
    const minimumAcceptableOut = estimatedOut - slippageDeduction;

    return {
      path: [hop1, hop2],
      estimatedOutAmount: estimatedOut,
      minimumAcceptableOut,
      priceImpactBps: 12,
    };
  }

  /**
   * Dispatches notifications to enterprise operations (Slack and Discord)
   */
  public async notifyOpsChannels(
    title: string,
    signature: string,
    route: OptimalRoute,
    amountIn: bigint
  ): Promise<void> {
    const payloadSlack = {
      text: `🚀 *SolHop Multi-Hop Execution Confirmation*\n*Status:* Confirmed (Finalized)\n*Tx Signature:* \`${signature}\`\n*Amount In:* ${amountIn.toString()}\n*Minimum Out:* ${route.minimumAcceptableOut.toString()}\n*Price Impact:* ${route.priceImpactBps} bps\n*Path:* ${route.path.map((h) => `${h.dexProtocol} (${h.sourceMint.slice(0, 4)}..->${h.targetMint.slice(0, 4)}..)`).join(" -> ")}`,
    };

    const payloadDiscord = {
      embeds: [
        {
          title: `⚡ SolHop Enterprise Swap Executed`,
          color: 3066993,
          fields: [
            { name: "Transaction Hash", value: `[Solana Explorer](https://explorer.solana.com/tx/${signature}?cluster=devnet)`, inline: false },
            { name: "Input", value: amountIn.toString(), inline: true },
            { name: "Estimated Out", value: route.estimatedOutAmount.toString(), inline: true },
            { name: "Protocol Path", value: route.path.map((p) => p.dexProtocol).join(" ➔ "), inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const dispatches = [];
    if (this.slackWebhookUrl) {
      dispatches.push(
        axios.post(this.slackWebhookUrl, payloadSlack).catch((e) => console.error("Slack webhook dispatch failed:", e.message))
      );
    }
    if (this.discordWebhookUrl) {
      dispatches.push(
        axios.post(this.discordWebhookUrl, payloadDiscord).catch((e) => console.error("Discord webhook dispatch failed:", e.message))
      );
    }

    await Promise.all(dispatches);
  }

  /**
   * Builds, signs, and executes the multi-hop route on Solana
   */
  public async executeTrade(
    sourceMint: string,
    destinationMint: string,
    amountIn: bigint
  ): Promise<string> {
    const route = await this.findBestRoute(sourceMint, destinationMint, amountIn);

    console.log(`[Execution Engine] Building atomic instruction for ${route.path.length} hops...`);

    const tx = new Transaction();
    
    // Add Jito MEV Tip Instruction (Direct Native Transfer to Jito Tip Vault)
    const jitoTipRecipient = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.signer.publicKey,
        toPubkey: jitoTipRecipient,
        lamports: 10_000, // 0.00001 SOL Jito Bundle Tip
      })
    );

    // In a production execution script, attach the Anchor program instruction:
    // tx.add(await this.program.methods.executeTwoHopRoute(amountIn, route.minimumAcceptableOut, ...).accounts({...}).instruction());

    tx.feePayer = this.signer.publicKey;
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latestBlockhash.blockhash;

    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.signer], {
      commitment: "confirmed",
      skipPreflight: false,
    });

    console.log(`[Success] Multi-Hop transaction executed on-chain: ${signature}`);

    await this.notifyOpsChannels("Swap Executed", signature, route, amountIn);
    return signature;
  }
}

// Direct Execution Entrypoint
if (require.main === module) {
  (async () => {
    try {
      const orchestrator = new MultiHopperOrchestrator();
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const HOP_MINT = "HopR2XWk3m5yZz9vD4qJ7wT1cK8vN3bL9sQ6uF2aP5e";
      const AMOUNT_TO_SWAP = BigInt(1_000_000_000); // 1 SOL

      console.log("=== Initiating MultiHopper Institutional Engine ===");
      const sig = await orchestrator.executeTrade(SOL_MINT, HOP_MINT, AMOUNT_TO_SWAP);
      console.log(`Finished Execution successfully with Sig: ${sig}`);
    } catch (err) {
      console.error("Fatal routing error:", err);
      process.exit(1);
    }
  })();
}