import { randomUUID } from "node:crypto";

export interface SendVerificationCodeInput {
  phone: string;
  code: string;
  expiresInMinutes: number;
}

export interface SmsGateway {
  sendVerificationCode(input: SendVerificationCodeInput): Promise<{
    messageId: string;
  }>;
}

export class ConsoleSmsGateway implements SmsGateway {
  async sendVerificationCode(input: SendVerificationCodeInput) {
    const messageId = `dev-${randomUUID()}`;
    console.info("Development SMS verification code", {
      phone: input.phone,
      code: input.code,
      expiresInMinutes: input.expiresInMinutes,
      messageId,
    });
    return { messageId };
  }
}
