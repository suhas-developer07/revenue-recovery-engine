import { Adapter } from "./adapter.interface";

export class EmailAdapter implements Adapter {
  async send(params: { to: string; message: string }) {
    console.log(`[EMAIL] to=${params.to} message=${params.message}`);
    return { success: true, messageId: `email-stub-${Date.now()}` };
  }
}
