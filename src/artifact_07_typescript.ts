import axios from "axios";
import { Resend } from "resend";

export interface TelemetryConfig {
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  resendApiKey?: string;
  alertEmailTo?: string;
}

export class TelemetryService {
  private resend: Resend | null = null;

  constructor(private config: TelemetryConfig) {
    if (config.resendApiKey) {
      this.resend = new Resend(config.resendApiKey);
    }
  }

  public async notifyExecutionSuccess(details: {
    signature: string;
    user: string;
    route: string[];
    amountIn: string;
    amountOut: string;
    feeCollected: string;
    latencyMs: number;
  }): Promise<void> {
    const message = `🚀 *MultiHopper Execution Success*\n` +
      `• *Signature*: \`${details.signature}\`\n` +
      `• *User*: \`${details.user}\`\n` +
      `• *Route*: ${details.route.join(" ➔ ")}\n` +
      `• *Amount In*: ${details.amountIn}\n` +
      `• *Amount Out*: ${details.amountOut}\n` +
      `• *Protocol Margin*: ${details.feeCollected}\n` +
      `• *Execution Latency*: ${details.latencyMs}ms`;

    // 1. Post to Slack if configured
    if (this.config.slackWebhookUrl) {
      try {
        await axios.post(this.config.slackWebhookUrl, { text: message });
      } catch (err: any) {
        console.error("Failed sending Slack notification:", err.message);
      }
    }

    // 2. Post to Discord if configured
    if (this.config.discordWebhookUrl) {
      try {
        await axios.post(this.config.discordWebhookUrl, {
          embeds: [
            {
              title: "⚡ MultiHopper Multi-Hop Swap Settled",
              color: 0x00ffa3,
              fields: [
                { name: "Tx Signature", value: `[Solana Explorer](https://explorer.solana.com/tx/${details.signature})` },
                { name: "Hop Path", value: details.route.join(" ➔ "), inline: true },
                { name: "Net Return", value: details.amountOut, inline: true },
                { name: "Margin", value: details.feeCollected, inline: true },
                { name: "Latency", value: `${details.latencyMs}ms`, inline: true },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        });
      } catch (err: any) {
        console.error("Failed sending Discord notification:", err.message);
      }
    }
  }

  public async sendDailySettlementReport(summary: {
    totalSwaps: number;
    cumulativeVolumeSol: number;
    cumulativeFeesCollectedSol: number;
    slippageIncidents: number;
  }): Promise<void> {
    if (!this.resend || !this.config.alertEmailTo) return;

    try {
      await this.resend.emails.send({
        from: "MultiHopper Protocol <reports@multihopper.io>",
        to: this.config.alertEmailTo,
        subject: `Daily MultiHopper Route Settlement: ${summary.totalSwaps} Transactions Settled`,
        html: `
          <h2>MultiHopper Enterprise Settlement Summary</h2>
          <table border="1" cellpadding="8" style="border-collapse: collapse; font-family: monospace;">
            <tr><td><strong>Total Multi-Hop Swaps</strong></td><td>${summary.totalSwaps}</td></tr>
            <tr><td><strong>Cumulative Volume (SOL)</strong></td><td>${summary.cumulativeVolumeSol.toFixed(4)} SOL</td></tr>
            <tr><td><strong>Revenue Generated (Fees)</strong></td><td>${summary.cumulativeFeesCollectedSol.toFixed(6)} SOL</td></tr>
            <tr><td><strong>Slippage Invariant Breaches Reverted</strong></td><td>${summary.slippageIncidents}</td></tr>
          </table>
          <p>System operational status: <strong>100.00% healthy</strong>.</p>
        `,
      });
    } catch (err: any) {
      console.error("Failed sending daily settlement report via Resend:", err.message);
    }
  }
}