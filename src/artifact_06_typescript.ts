import { Resend } from 'resend';
import axios from 'axios';

export interface ExecutionReceipt {
  signature: string;
  sender: string;
  inputToken: string;
  outputToken: string;
  amountIn: string;
  amountOut: string;
  hopsCount: number;
  jitoTipSol: number;
  executionTimeMs: number;
}

export class TelemetryService {
  private resend: Resend | null = null;
  private slackWebhookUrl: string | null = null;
  private recipientEmail: string | null = null;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || null;
    this.recipientEmail = process.env.AUDIT_EMAIL_RECIPIENT || null;
  }

  public async dispatchExecutionReceipt(receipt: ExecutionReceipt): Promise<void> {
    console.log(`[Telemetry] Dispatching audit trail for tx: ${receipt.signature}`);

    // 1. Send Enterprise Email via Resend
    if (this.resend && this.recipientEmail) {
      try {
        await this.resend.emails.send({
          from: 'MultiHopper Engine <telemetry@multihopper.fi>',
          to: [this.recipientEmail],
          subject: `[EXECUTION SUCCESS] Multi-Hop Swap: ${receipt.signature.slice(0, 8)}...`,
          html: `
            <h2>MultiHopper Swap Execution Audit Receipt</h2>
            <p><strong>Transaction Signature:</strong> <a href="https://solscan.io/tx/${receipt.signature}">${receipt.signature}</a></p>
            <ul>
              <li><strong>Initiator:</strong> ${receipt.sender}</li>
              <li><strong>Input Route:</strong> ${receipt.amountIn} (${receipt.inputToken})</li>
              <li><strong>Settled Amount:</strong> ${receipt.amountOut} (${receipt.outputToken})</li>
              <li><strong>Total Hops:</strong> ${receipt.hopsCount}</li>
              <li><strong>Jito MEV Tip:</strong> ${receipt.jitoTipSol} SOL</li>
              <li><strong>Execution Latency:</strong> ${receipt.executionTimeMs} ms</li>
            </ul>
            <p><em>Cryptographically validated by MultiHopper Solana Protocol Engine.</em></p>
          `,
        });
        console.log(`[Telemetry] Audit email sent via Resend.`);
      } catch (err) {
        console.error(`[Telemetry Error] Failed sending Resend email:`, err);
      }
    }

    // 2. Dispatch Slack / Discord Webhook
    if (this.slackWebhookUrl) {
      try {
        await axios.post(this.slackWebhookUrl, {
          text: `*MultiHopper Route Settled* \`${receipt.signature}\`\n- User: \`${receipt.sender}\`\n- Hops: ${receipt.hopsCount}\n- In: ${receipt.amountIn} -> Out: ${receipt.amountOut}\n- Jito Tip: ${receipt.jitoTipSol} SOL (${receipt.executionTimeMs}ms)`,
        });
        console.log(`[Telemetry] Slack webhook emitted.`);
      } catch (err) {
        console.error(`[Telemetry Error] Slack webhook failed:`, err);
      }
    }
  }
}