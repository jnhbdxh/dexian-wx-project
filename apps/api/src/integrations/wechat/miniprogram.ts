import type { WechatMiniProgramConfig } from "../../config/env.js";

export interface WechatSessionResult {
  openId: string;
  unionId?: string;
}

export interface WechatMiniProgramGateway {
  exchangeCode(code: string): Promise<WechatSessionResult>;
}

export class WechatMiniProgramRequestError extends Error {
  constructor(
    readonly kind: "credential" | "configuration" | "temporary",
    readonly channelCode: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class WechatMiniProgramHttpGateway implements WechatMiniProgramGateway {
  constructor(private readonly config: WechatMiniProgramConfig) {}

  async exchangeCode(code: string): Promise<WechatSessionResult> {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({
      appid: this.config.appId,
      secret: this.config.appSecret,
      js_code: code,
      grant_type: "authorization_code",
    }).toString();

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      throw new WechatMiniProgramRequestError(
        "temporary",
        undefined,
        error instanceof Error ? error.message : "WeChat request failed",
      );
    }

    let body: {
      openid?: string;
      unionid?: string;
      errcode?: number;
      errmsg?: string;
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new WechatMiniProgramRequestError(
        "temporary",
        response.status,
        "WeChat returned an invalid response",
      );
    }
    if (!response.ok || body.errcode || !body.openid) {
      const credentialErrors = new Set([40029, 40163, 41008]);
      const configurationErrors = new Set([40013, 40125]);
      const kind = body.errcode
        ? credentialErrors.has(body.errcode)
          ? "credential"
          : configurationErrors.has(body.errcode)
            ? "configuration"
            : "temporary"
        : "temporary";
      throw new WechatMiniProgramRequestError(
        kind,
        body.errcode ?? response.status,
        `WeChat code exchange failed: ${body.errcode ?? response.status} ${body.errmsg ?? response.statusText}`,
      );
    }
    return {
      openId: body.openid,
      ...(body.unionid ? { unionId: body.unionid } : {}),
    };
  }
}
