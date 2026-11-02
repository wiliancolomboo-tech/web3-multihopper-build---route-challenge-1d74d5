import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

export interface RouteTelemetryPayload {
  txSignature: string;
  userAddress: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  amountOut: string;
  slippageToleranceBps: number;
  hopCount: number;
  executionDurationMs: number;
}

export class EnterpriseTelemetryAdapter {
  private resendClient: Resend | null = null;
  private discordWebhookUrl: string | undefined;
  private slackWebhookUrl: string | undefined;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resendClient = new Resend(process.env.RESEND_API_KEY);
    }
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  }

  public async broadcastExecutionSuccess(payload: RouteTelemetryPayload): Promise<void> {
    const formattedMessage = {
      title: "🚀 MultiHopper Atomic Route Executed",
      color: 0x00ff66,
      fields: [
        { name: "Transaction Signature", value: `\`${payload.txSignature}\``, inline: false },
        { name: "Signer", value: payload.userAddress, inline: true },
        { name: "Hops Cleared", value: payload.hopCount.toString(), inline: true },
        { name: "Execution Time", value: `${payload.executionDurationMs} ms`, inline: true },
        { name: "Amount In", value: payload.amountIn, inline: true },
        { name: "Realized Amount Out", value: payload.amountOut, inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    // 1. Dispatch Discord Alert
    if (this.discordWebhookUrl) {
      try {
        await axios.post(this.discordWebhookUrl, { embeds: [formattedMessage] });
      } catch (err: any) {
        console.error("Failed to push Discord webhook telemetry:", err.message);
      }
    }

    // 2. Dispatch Slack Alert
    if (this.slackWebhookUrl) {
      try {
        await axios.post(this.slackWebhookUrl, {
          text: `*MultiHopper Execution Success*\nTx: \`${payload.txSignature}\`\nIn: ${payload.amountIn} -> Out: ${payload.amountOut} (${payload.hopCount} hops)`,
        });
      } catch (err: any) {
        console.error("Failed to push Slack webhook telemetry:", err.message);
      }
    }

    // 3. Dispatch Enterprise Resend Email
    if (this.resendClient && process.env.ENTERPRISE_ALERT_EMAIL) {
      try {
        await this.resendClient.emails.send({
          from: "routing-engine@multihopper.io",
          to: process.env.ENTERPRISE_ALERT_EMAIL,
          subject: `[EXECUTION NOTIFICATION] MultiHopper Trade Cleared: ${payload.txSignature.slice(0, 8)}...`,
          html: `
            <h2>MultiHopper Atomic Swap Executed Successfully</h2>
            <p><strong>Transaction Signature:</strong> <a href="https://solscan.io/tx/${payload.txSignature}">${payload.txSignature}</a></p>
            <ul>
              <li><strong>Signer Address:</strong> ${payload.userAddress}</li>
              <li><strong>Input Mint:</strong> ${payload.inputMint}</li>
              <li><strong>Output Mint:</strong> ${payload.outputMint}</li>
              <li><strong>Amount In:</strong> ${payload.amountIn}</li>
              <li><strong>Amount Out (Settled):</strong> ${payload.amountOut}</li>
              <li><strong>Total Hops:</strong> ${payload.hopCount}</li>
              <li><strong>Engine Latency:</strong> ${payload.executionDurationMs} ms</li>
            </ul>
            <p>Protected against sandwich attacks via Jito-Solana bundle builder.</p>
          `,
        });
      } catch (err: any) {
        console.error("Failed to send Resend email dispatch:", err.message);
      }
    }
  }
}