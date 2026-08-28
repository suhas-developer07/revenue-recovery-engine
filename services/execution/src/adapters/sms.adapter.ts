import { Adapter } from "./adapter.interface";

export class SMSAdapter implements Adapter {
  async send(params: { to: string; message: string }) {
    console.log(`[SMS] to=${params.to} message=${params.message}`);
    return { success: true, messageId: `sms-stub-${Date.now()}` };
  }
}
