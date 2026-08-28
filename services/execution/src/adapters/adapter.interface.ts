export interface Adapter {
  send(params: { to: string; message: string; metadata?: Record<string, unknown> }): Promise<{ success: boolean; messageId: string }>;
}
