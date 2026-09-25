import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { OA_HTTP_TIMEOUT_MS, WechatOaConfig } from './wechat-oa.config';

@Injectable()
export class WechatOaTokenService {
    private token: string | null = null;
    private expiresAt = 0;
    private refreshing: Promise<string> | null = null;

    constructor(private readonly http: HttpService, private readonly config: WechatOaConfig) {}

    async get(): Promise<string> {
        if (!this.config.sendEnabled && !this.config.syncEnabled) throw new Error('OA_DISABLED');
        if (!this.config.credentialsReady()) throw new Error('OA_CONFIG_INVALID');
        if (this.token && Date.now() < this.expiresAt) return this.token;
        if (!this.refreshing) {
            this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
        }
        return this.refreshing;
    }

    invalidate(token: string): void {
        if (this.token === token) { this.token = null; this.expiresAt = 0; }
    }

    private async refresh(): Promise<string> {
        const startedAt = Date.now();
        let data: any;
        try {
            ({ data } = await firstValueFrom(this.http.get('https://api.weixin.qq.com/cgi-bin/token', {
                params: { grant_type: 'client_credential', appid: this.config.appId, secret: this.config.secret },
                timeout: OA_HTTP_TIMEOUT_MS, maxRedirects: 0,
            })));
        } catch { throw new Error('OA_TOKEN_TRANSPORT'); }
        if (data?.errcode) throw new Error(`OA_TOKEN_ERROR_${Number(data.errcode) || 'INVALID'}`);
        if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
            throw new Error('OA_TOKEN_INVALID_RESPONSE');
        }
        this.token = data.access_token;
        this.expiresAt = startedAt + Math.max(1, data.expires_in - Math.min(300, data.expires_in / 10)) * 1000;
        return this.token;
    }
}
