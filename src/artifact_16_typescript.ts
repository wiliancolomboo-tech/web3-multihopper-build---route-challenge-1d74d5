import { Resend } from "resend";
import { RouteNotificationPayload } from "./notification";

export class InstitutionalReceiptService {
  private resend: Resend | null = null;
  private recipientEmail: string | undefined;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    this.recipientEmail = process.env.RESEND_RECIPIENT_EMAIL;
    if (apiKey) {
      this.resend = new Resend(apiKey);
    }
  }

  public async sendExecutionReceipt(payload: RouteNotificationPayload): Promise<void> {
    if (!this.resend || !this.recipientEmail) {
      console.warn("[Receipt] Resend API key or recipient email missing. Skipping email receipt.");
      return;
    }

    try {
      await this.resend.emails.send({
        from: "MultiHopper Settlement <receipts@resend.dev>",
        to: [this.recipientEmail],
        subject: `[Trade Confirmation] Multi-Hop Route Execution: ${payload.txSignature.slice(0, 8)}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #0f172a; margin-top: 0;">MultiHopper Settlement Confirmation</h2>
            <p style="color: #475569;">Atomic multi-hop transaction finalized on Solana.</p>
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 0; color: #64748b;">Transaction Signature</td>
                <td style="padding: 8px 0; font-family: monospace; font-size: 12px; text-align: right;">${payload.txSignature}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 0; color: #64748b;">Hops Completed</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 600;">${payload.hopsCount}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 0; color: #64748b;">Input Capital</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 600;">${payload.amountIn} units</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 0; color: #64748b;">Net Settled Capital</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #16a34a;">${payload.amountOut} units</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 0; color: #64748b;">Partner Cut Split</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 600;">${payload.partnerCut}</td>
              </tr>
            </table>
            <div style="margin-top: 24px; padding: 12px; background-color: #f8fafc; border-radius: 6px; font-size: 12px; color: #64748b; text-align: center;">
              Cryptographically verified by MultiHopper Solana Program • Zero Transient Residuals
            </div>
          </div>
        `,
      });
      console.log("[Receipt] Institutional execution receipt delivered via Resend.");
    } catch (err: any) {
      console.error("[Receipt] Resend dispatch failed:", err.message);
    }
  }
}