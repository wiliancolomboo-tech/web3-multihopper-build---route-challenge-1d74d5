import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  AccountMeta
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration Interfaces
export interface HopStep {
  dexProgramId: PublicKey;
  poolAddress: PublicKey;
  vaultIn: PublicKey;
  vaultOut: PublicKey;
  estimatedReturn: BN;
}

export interface RouteQuote {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: BN;
  estimatedAmountOut: BN;
  minimumAmountOut: BN;
  hops: HopStep[];
  integratorBps: number;
}

export class MultiHopperEnterpriseAgent {
  private connection: Connection;
  private wallet: Keypair;
  private programId: PublicKey;
  private resendClient: Resend | null;
  private discordWebhookUrl: string | undefined;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");

    const privateKeyRaw = process.env.AGENT_PRIVATE_KEY;
    if (!privateKeyRaw) {
      throw new Error("AGENT_PRIVATE_KEY is missing from environment variables.");
    }
    this.wallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(privateKeyRaw)));
    this.programId = new PublicKey(
      process.env.MULTI_HOPPER_PROGRAM_ID || "MHoP8uNq1xPZkH3vKkM9N5Q9w2e3F4r5T6y7U8i9o0P"
    );

    const resendApiKey = process.env.RESEND_API_KEY;
    this.resendClient = resendApiKey ? new Resend(resendApiKey) : null;
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  }

  /**
   * Dispatches real-time swap notifications to Discord / Slack
   */
  public async notifyTelemetry(txSignature: string, quote: RouteQuote, actualReceived: BN): Promise<void> {
    if (!this.discordWebhookUrl) return;

    const payload = {
      username: "MultiHopper Sentry",
      avatar_url: "https://solana.com/src/img/branding/solanaLogoMark.png",
      embeds: [
        {
          title: "🚀 Multi-Hop Swap Executed",
          color: 0x14f195,
          fields: [
            { name: "Transaction Signature", value: `[${txSignature.slice(0, 16)}...](https://solscan.io/tx/${txSignature})`, inline: false },
            { name: "Input Token Amount", value: quote.amountIn.toString(), inline: true },
            { name: "Output Received", value: actualReceived.toString(), inline: true },
            { name: "Hop Count", value: `${quote.hops.length} Hops`, inline: true },
            { name: "Integrator Share Applied", value: `${quote.integratorBps / 100}%`, inline: true }
          ],
          footer: { text: "MultiHopper High-Frequency Enterprise Engine" },
          timestamp: new Date().toISOString()
        }
      ]
    };

    try {
      await axios.post(this.discordWebhookUrl, payload, { timeout: 3000 });
    } catch (err: any) {
      console.error("[Telemetry] Failed to post webhook notification:", err.message);
    }
  }

  /**
   * Emits formal audit digest via Resend API to institutional treasury team
   */
  public async sendAuditReconciliationEmail(
    recipientEmail: string,
    txSignature: string,
    quote: RouteQuote
  ): Promise<void> {
    if (!this.resendClient) {
      console.warn("[Resend] Client unconfigured; skipping email dispatch.");
      return;
    }

    try {
      await this.resendClient.emails.send({
        from: "settlement@multihopper.io",
        to: recipientEmail,
        subject: `[EXECUTION AUDIT] Multi-Hop Trade Settlement - ${txSignature.slice(0, 8)}`,
        html: `
          <h2>MultiHopper Protocol Settlement Confirmation</h2>
          <p><strong>Transaction Signature:</strong> ${txSignature}</p>
          <p><strong>Input Amount:</strong> ${quote.amountIn.toString()}</p>
          <p><strong>Guaranteed Min Output:</strong> ${quote.minimumAmountOut.toString()}</p>
          <p><strong>Execution Route:</strong> ${quote.hops.length} Hop Sequential Split CPI</p>
          <hr/>
          <p><em>This record was generated cryptographically by the MultiHopper Daemon.</em></p>
        `
      });
      console.log(`[Audit] Reconciliation dispatch emailed successfully to ${recipientEmail}`);
    } catch (err: any) {
      console.error("[Audit] Resend email transmission error:", err.message);
    }
  }

  /**
   * Build Multi-Hop Accounts and Dispatch Swap Transaction
   */
  public async executeMultiHopSwap(
    quote: RouteQuote,
    userSourceToken: PublicKey,
    userDestToken: PublicKey,
    protocolTreasuryToken: PublicKey,
    integratorTokenVault: PublicKey
  ): Promise<string> {
    const [protocolConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      this.programId
    );

    const [integratorRecordPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("integrator"), this.wallet.publicKey.toBuffer()],
      this.programId
    );

    const [hopEscrowTokenPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("hop_escrow"), protocolConfigPDA.toBuffer()],
      this.programId
    );

    // Pack DEX pools into remaining accounts vector
    const remainingAccounts: AccountMeta[] = [];
    for (const hop of quote.hops) {
      remainingAccounts.push(
        { pubkey: hop.dexProgramId, isWritable: false, isSigner: false },
        { pubkey: hop.poolAddress, isWritable: true, isSigner: false },
        { pubkey: hop.vaultIn, isWritable: true, isSigner: false },
        { pubkey: hop.vaultOut, isWritable: true, isSigner: false }
      );
    }

    console.log(`[MultiHopper] Assembling atomic ${quote.hops.length}-hop transaction...`);

    const tx = new Transaction().add({
      programId: this.programId,
      keys: [
        { pubkey: protocolConfigPDA, isWritable: true, isSigner: false },
        { pubkey: integratorRecordPDA, isWritable: true, isSigner: false },
        { pubkey: this.wallet.publicKey, isWritable: true, isSigner: true },
        { pubkey: userSourceToken, isWritable: true, isSigner: false },
        { pubkey: userDestToken, isWritable: true, isSigner: false },
        { pubkey: hopEscrowTokenPDA, isWritable: true, isSigner: false },
        { pubkey: protocolTreasuryToken, isWritable: true, isSigner: false },
        { pubkey: integratorTokenVault, isWritable: true, isSigner: false },
        { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isWritable: false, isSigner: false },
        ...remainingAccounts
      ],
      data: Buffer.concat([
        Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]), // 8-byte Anchor discriminator for swap_exact_tokens_for_tokens
        quote.amountIn.toArrayLike(Buffer, "le", 8),
        quote.minimumAmountOut.toArrayLike(Buffer, "le", 8),
        Buffer.from([quote.hops.length])
      ])
    });

    const txSig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: "confirmed",
      skipPreflight: false
    });

    console.log(`[MultiHopper] Swap confirmed successfully! Tx Signature: ${txSig}`);

    // Asynchronously dispatch webhooks and corporate audits
    await this.notifyTelemetry(txSig, quote, quote.estimatedAmountOut);
    if (process.env.AUDIT_EMAIL_RECIPIENT) {
      await this.sendAuditReconciliationEmail(process.env.AUDIT_EMAIL_RECIPIENT, txSig, quote);
    }

    return txSig;
  }
}