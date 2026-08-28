import { Adapter } from "./adapter.interface";

export class WhatsAppAdapter implements Adapter {
  async send(params: { to: string; message: string }) {
    console.log(`[WHATSAPP] to=${params.to} message=${params.message}`);
    return { success: true, messageId: `whatsapp-stub-${Date.now()}` };
  }
}
