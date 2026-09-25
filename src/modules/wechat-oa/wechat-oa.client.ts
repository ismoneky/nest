import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { OA_HTTP_TIMEOUT_MS, WechatOaConfig } from './wechat-oa.config';
import { WechatOaTokenService } from './wechat-oa-token.service';
import { classifyOaError, OaFanInfo, OaFanPage, OaPayload, OaSendOutcome } from './wechat-oa.types';

const BASE = 'https://api.weixin.qq.com/cgi-bin/';
@Injectable()
export class WechatOaClient {
    constructor(private readonly http: HttpService, private readonly config: WechatOaConfig,
        private readonly tokens: WechatOaTokenService) {}

    getAccessToken(): Promise<string> { return this.tokens.get(); }
    invalidateToken(token: string): void { this.tokens.invalidate(token); }

    async listFans(cursor: string): Promise<OaFanPage> {
        const data = await this.read('user/get', { next_openid: cursor });
        const ids = data?.data?.openid ?? (data?.count === 0 ? [] : null);
        if (!Number.isInteger(data?.total) || data.total < 0 || !Number.isInteger(data?.count)
            || !Array.isArray(ids) || ids.length !== data.count || ids.length > 10000
            || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length
            || (data.count === 0 && data.total !== 0 && !cursor)
            || (data.next_openid != null && typeof data.next_openid !== 'string')) {
            throw new Error('OA_INVALID_RESPONSE');
        }
        return { total: data.total, openids: ids, next: data.next_openid || '' };
    }

    async getFanInfo(openids: string[]): Promise<OaFanInfo[]> {
        if (!openids.length || openids.length > 100) throw new Error('OA_INVALID_BATCH');
        const data = await this.read('user/info/batchget', {}, { user_list: openids.map(openid => ({ openid, lang: 'zh_CN' })) });
        const infos = data?.user_info_list;
        if (!Array.isArray(infos) || infos.length !== openids.length || new Set(infos.map(i => i?.openid)).size !== infos.length
            || infos.some(i => !i || !openids.includes(i.openid) || ![0, 1].includes(i.subscribe)
                || (i.unionid != null && typeof i.unionid !== 'string'))) throw new Error('OA_INVALID_RESPONSE');
        return infos.map(i => ({ openid: i.openid, subscribe: i.subscribe, unionid: i.unionid || undefined }));
    }

    /** 同步 API 的 token 错误安全重试一次；发送接口由 worker 逐次记账。 */
    private async read(path: string, params: object, body?: object): Promise<any> {
        this.config.assertApiEnabled('sync');
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.tokens.get();
            const options = { params: { ...params, access_token: token }, timeout: OA_HTTP_TIMEOUT_MS, maxRedirects: 0 };
            let data: any;
            try {
                ({ data } = await firstValueFrom(body ? this.http.post(BASE + path, body, options) : this.http.get(BASE + path, options)));
            } catch { throw new Error('OA_READ_TRANSPORT'); }
            if (!data || typeof data !== 'object') throw new Error('OA_INVALID_RESPONSE');
            if (data.errcode) {
                const error = classifyOaError(Number(data.errcode));
                if (error.kind === 'token' && attempt === 0) { this.tokens.invalidate(token); continue; }
                throw new Error(`OA_READ_ERROR_${Number(data.errcode) || 'INVALID'}`);
            }
            return data;
        }
        throw new Error('OA_READ_TOKEN_RETRY_EXHAUSTED');
    }

    async sendTemplate(payload: OaPayload & { touser: string }, token: string): Promise<OaSendOutcome> {
        this.config.assertApiEnabled('send');
        let data: any;
        try {
            ({ data } = await firstValueFrom(this.http.post(BASE + 'message/template/send', payload, {
                params: { access_token: token }, timeout: OA_HTTP_TIMEOUT_MS, maxRedirects: 0,
            })));
        } catch { return { kind: 'unknown', code: 'TRANSPORT' }; }
        if (data?.errcode === 0 && ((typeof data.msgid === 'string' && data.msgid.trim().length > 0) || Number.isSafeInteger(data.msgid))) {
            return { kind: 'accepted', msgId: String(data.msgid) };
        }
        if (Number.isInteger(data?.errcode) && data.errcode !== 0) return classifyOaError(data.errcode);
        return { kind: 'unknown', code: 'INVALID_RESPONSE' };
    }
}
