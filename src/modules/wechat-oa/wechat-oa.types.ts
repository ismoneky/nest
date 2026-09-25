export interface OaFanPage { total: number; openids: string[]; next: string }
export interface OaFanInfo { openid: string; subscribe: 0 | 1; unionid?: string }
export interface OaPayload {
    template_id: string;
    miniprogram: { appid: string; pagepath: string };
    data: Record<string, { value: string }>;
}
export type OaSendOutcome = { kind: 'accepted'; msgId: string }
    | { kind: 'token' | 'not_subscribed' | 'retryable' | 'rate_limit' | 'permanent' | 'unknown'; code: number | string };

export function classifyOaError(code: number): Exclude<OaSendOutcome, { kind: 'accepted' }> {
    if ([40001, 40014, 42001].includes(code)) return { kind: 'token', code };
    if (code === 43004) return { kind: 'not_subscribed', code };
    if (code === -1) return { kind: 'retryable', code };
    if (code === 45009) return { kind: 'rate_limit', code };
    return { kind: 'permanent', code };
}
