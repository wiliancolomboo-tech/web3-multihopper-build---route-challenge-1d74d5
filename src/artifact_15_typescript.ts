import axios from "axios";

export interface RouteNotificationPayload {
  txSignature: string;
  user: string;
  partner: string;
  amountIn: string;
  amountOut: string;
  inputMint: string;
  outputMint: string;
  totalFee: string;
  partnerCut: string;
  hopsCount: number;
}

export class NotificationService {
  private webhookUrl: string | undefined;

  constructor() {
    this.webhookUrl = process.env.DISCORD_SLACK_WEBHOOK_URL;
  }

  public async broadcastExecution(payload: RouteNotificationPayload): Promise<void> {
    if (!this.webhookUrl) {
      console.warn("[Telemetry] DISCORD_SLACK_WEBHOOK_URL not configured. Skipping webhook.");
      return;
    }

    const message = {
      username: "MultiHopper Sentinel",
      avatar_url: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
      embeds: [
        {
          title: "🚀 MultiHopper Atomic Swap Executed",
          color: 0x14f195, // Solana Green
          fields: [
            { name: "Tx Signature", value: `[${payload.txSignature.slice(0, 16)}...](https://explorer.solana.com/tx/${payload.txSignature}?cluster=devnet)`, inline: false },
            { name: "Input Amount", value: `${payload.amountIn} (${payload.inputMint.slice(0, 6)}...)`, inline: true },
            { name: "Settled Output", value: `${payload.amountOut} (${payload.outputMint.slice(0, 6)}...)`, inline: true },
            { name: "Hops Traversed", value: `${payload.hopsCount}`, inline: true },
            { name: "Protocol Fee", value: payload.totalFee, inline: true },
            { name: "Partner Rev-Share", value: payload.partnerCut, inline: true },
            { name: "Integrator", value: `${payload.partner.slice(0, 8)}...`, inline: true },
          ],
          footer: { text: "MultiHopper Enterprise Engine • Solana Mainnet/Devnet" },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      await axios.post(this.webhookUrl, message, { timeout: 5000 });
      console.log("[Telemetry] Webhook alert successfully dispatched.");
    } catch (err: any) {
      console.error("[Telemetry] Failed to post webhook:", err.message);
    }
  }
}