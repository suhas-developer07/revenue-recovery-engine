import { Adapter } from "./adapter.interface";

export class VoiceAdapter implements Adapter {
  async send(params: { to: string; message: string }) {
    console.log(`[VOICE] to=${params.to} message=${params.message}`);
    return { success: true, messageId: `voice-stub-${Date.now()}` };
  }
}
