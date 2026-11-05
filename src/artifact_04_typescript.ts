import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import axios from "axios";
import * as fs from "fs";

export interface SwapRouteHop {
  poolSource: PublicKey;
  poolDest: PublicKey;
  poolAuthority: PublicKey;
}

export interface MultiHopperExecutionParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: anchor.BN;
  minAmountOut: anchor.BN;
  referrerFeeBps: number;
  referrerTokenAccount?: PublicKey;
  hops: SwapRouteHop[];
}

export class MultiHopperClient {
  public program: Program;
  public connection: Connection;
  public wallet: anchor.Wallet;

  constructor(
    programId: PublicKey,
    connection: Connection,
    payerKeypair: Keypair,
    idl: anchor.Idl
  ) {
    this.connection = connection;
    this.wallet = new anchor.Wallet(payerKeypair);
    const provider = new anchor.AnchorProvider(
      this.connection,
      this.wallet,
      anchor.AnchorProvider.defaultOptions()
    );
    this.program = new Program(idl, programId, provider);
  }

  public static getProgramConfigPda(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId
    );
  }

  public async executeRoute(params: MultiHopperExecutionParams): Promise<string> {
    const [configPda] = MultiHopperClient.getProgramConfigPda(this.program.programId);
    const configAccount = await (this.program.account as any).protocolConfig.fetch(configPda);

    const userSourceAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.wallet.payer,
      params.inputMint,
      this.wallet.publicKey
    );

    const userDestAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.wallet.payer,
      params.outputMint,
      this.wallet.publicKey
    );

    const protocolVaultIn = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.wallet.payer,
      params.inputMint,
      configPda,
      true
    );

    const protocolVaultOut = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.wallet.payer,
      params.outputMint,
      configPda,
      true
    );

    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.wallet.payer,
      params.outputMint,
      configAccount.treasury
    );

    // Pack remaining accounts: [poolSource, poolDest, poolAuth] for each hop
    const remainingAccounts: anchor.web3.AccountMeta[] = [];
    for (const hop of params.hops) {
      remainingAccounts.push(
        { pubkey: hop.poolSource, isWritable: true, isSigner: false },
        { pubkey: hop.poolDest, isWritable: true, isSigner: false },
        { pubkey: hop.poolAuthority, isWritable: false, isSigner: false }
      );
    }

    // Set Priority Fees for fast inclusion (ComputeBudget)
    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 50_000,
    });
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    const tx = await this.program.methods
      .executeMultiHopRoute(
        params.amountIn,
        params.minAmountOut,
        params.referrerFeeBps
      )
      .accounts({
        config: configPda,
        user: this.wallet.publicKey,
        userSourceToken: userSourceAta.address,
        protocolVaultIn: protocolVaultIn.address,
        protocolVaultOut: protocolVaultOut.address,
        userDestinationToken: userDestAta.address,
        treasuryTokenAccount: treasuryAta.address,
        referrerTokenAccount: params.referrerTokenAccount || null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions([priorityFeeIx, computeLimitIx])
      .transaction();

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet.payer],
      { commitment: "confirmed" }
    );

    return signature;
  }

  /**
   * Enterprise Webhook Notifier: Dispatches execution audit payloads to Slack and Resend API.
   */
  public async dispatchExecutionReceipt(payload: {
    txHash: string;
    user: string;
    amountIn: string;
    amountOut: string;
    hops: number;
    slackWebhookUrl?: string;
    resendApiKey?: string;
    notificationEmail?: string;
  }) {
    const timestamp = new Date().toISOString();

    // 1. Enterprise Slack/Discord Alert
    if (payload.slackWebhookUrl) {
      const message = {
        text: `⚡ *MultiHopper Trade Executed*`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "⚡ MultiHopper Trade Execution Confirmed",
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*User:* \`${payload.user}\`` },
              { type: "mrkdwn", text: `*Hops:* ${payload.hops}` },
              { type: "mrkdwn", text: `*Input Amount:* ${payload.amountIn}` },
              { type: "mrkdwn", text: `*Output Amount:* ${payload.amountOut}` },
              {
                type: "mrkdwn",
                text: `*Solana Tx:* <https://solscan.io/tx/${payload.txHash}|View Solscan>`,
              },
              { type: "mrkdwn", text: `*Timestamp:* ${timestamp}` },
            ],
          },
        ],
      };
      await axios.post(payload.slackWebhookUrl, message);
    }

    // 2. Resend Compliance Email Receipt
    if (payload.resendApiKey && payload.notificationEmail) {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "compliance@multihopper.fi",
          to: [payload.notificationEmail],
          subject: `[Trade Audit] MultiHopper Execution: ${payload.txHash.slice(0, 8)}...`,
          html: `
            <h2>Trade Execution Confirmation</h2>
            <p><strong>Transaction Signature:</strong> ${payload.txHash}</p>
            <p><strong>User:</strong> ${payload.user}</p>
            <p><strong>Routing Hops:</strong> ${payload.hops}</p>
            <p><strong>Gross Input:</strong> ${payload.amountIn}</p>
            <p><strong>Net Output:</strong> ${payload.amountOut}</p>
            <p><strong>Timestamp:</strong> ${timestamp}</p>
            <hr />
            <p>MultiHopper Protocol Automated Auditing Engine</p>
          `,
        },
        {
          headers: {
            Authorization: `Bearer ${payload.resendApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
    }
  }
}

// -----------------------------------------------------------------------------
// CLI RUNNER ENTRYPOINT
// -----------------------------------------------------------------------------
async function runCli() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const connection = new Connection(rpcUrl, "confirmed");
  const keypairPath = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
  );

  const programId = new PublicKey("Hopr111111111111111111111111111111111111111");
  const idl = JSON.parse(
    fs.readFileSync("./target/idl/multi_hopper.json", "utf-8")
  );

  const client = new MultiHopperClient(programId, connection, payer, idl);
  console.log(`[MultiHopper CLI] Initialized. Operator: ${payer.publicKey.toBase58()}`);
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}