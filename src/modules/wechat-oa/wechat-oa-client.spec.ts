import { of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { resolve } from 'path';
import { WechatOaConfig } from './wechat-oa.config';
import { WechatOaTokenService } from './wechat-oa-token.service';
import { WechatOaClient } from './wechat-oa.client';

describe('服务号配置和 HTTP 客户端', () => {
    const env = { ...process.env };
    let http: { get: jest.Mock; post: jest.Mock };
    beforeEach(() => {
        process.env = { ...env, OA_ENABLED: 'true', OA_SYNC_ENABLED: 'true', OA_APPID: 'wx0123456789abcdef',
            OA_SECRET: 'abcdef0123456789abcdef0123456789', WX_APPID: 'wxfedcba9876543210', OA_TEMPLATES_FILE: '' };
        http = { get: jest.fn(), post: jest.fn() };
    });
    afterEach(() => { process.env = env; jest.restoreAllMocks(); });
    function client() {
        const config = new WechatOaConfig();
        const tokens = new WechatOaTokenService(http as any, config);
        return { config, tokens, api: new WechatOaClient(http as any, config, tokens) };
    }

    it('关闭或占位凭据禁止网络调用', async () => {
        process.env.OA_ENABLED = 'false'; process.env.OA_SYNC_ENABLED = 'false';
        await expect(client().api.listFans('')).rejects.toThrow('OA_DISABLED');
        process.env.OA_SYNC_ENABLED = 'true'; process.env.OA_SECRET = 'REPLACE_WITH_OA_SECRET';
        await expect(client().api.listFans('')).rejects.toThrow('OA_CONFIG_INVALID');
        expect(http.get).not.toHaveBeenCalled();
    });

    it.each(['', resolve(__dirname, '../../../config/wechat-oa-templates.example.json')])('未配置或占位模板应给出启动告警和可查询诊断：%s', path => {
        process.env.OA_TEMPLATES_FILE = path;
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { config } = client();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('OA_TEMPLATES_UNCONFIGURED'));
        expect(config.templateReadiness()).toEqual({ ORDER_EXPIRE_REMINDER: false, ORDER_EXPIRED: false,
            REFUND_ACCEPTED: false, REFUND_APPROVED: false, REFUND_REJECTED: false, REFUND_SUCCESS: false });
    });

    it('并发获取 token 合并，过期前缓存，旧请求不能删除新 token', async () => {
        http.get.mockReturnValue(of({ data: { access_token: 'token-a', expires_in: 7200 } }));
        const { tokens } = client();
        expect(await Promise.all([tokens.get(), tokens.get(), tokens.get()])).toEqual(['token-a', 'token-a', 'token-a']);
        expect(http.get).toHaveBeenCalledTimes(1);
        tokens.invalidate('token-a');
        http.get.mockReturnValue(of({ data: { access_token: 'token-b', expires_in: 7200 } }));
        await tokens.get(); tokens.invalidate('token-a');
        expect(await tokens.get()).toBe('token-b');
        expect(http.get).toHaveBeenCalledTimes(2);
    });

    it('列表返回 token 错误只刷新一次', async () => {
        http.get.mockReturnValueOnce(of({ data: { access_token: 'token-a', expires_in: 7200 } }))
            .mockReturnValueOnce(of({ data: { errcode: 42001 } }))
            .mockReturnValueOnce(of({ data: { access_token: 'token-b', expires_in: 7200 } }))
            .mockReturnValueOnce(of({ data: { total: 1, count: 1, data: { openid: ['oa-a'] }, next_openid: 'oa-a' } }));
        expect((await client().api.listFans('')).openids).toEqual(['oa-a']);
        expect(http.get).toHaveBeenCalledTimes(4);
    });

    it('异常列表结构不伪装成零粉丝', async () => {
        http.get.mockReturnValueOnce(of({ data: { access_token: 'token-a', expires_in: 7200 } }))
            .mockReturnValueOnce(of({ data: { total: 3, count: 0 } }));
        await expect(client().api.listFans('')).rejects.toThrow('OA_INVALID_RESPONSE');
    });

    it('发送返回受理凭证、明确退订；超时属于 UNKNOWN，错误不泄漏密钥', async () => {
        const { api } = client();
        http.post.mockReturnValueOnce(of({ data: { errcode: 0, msgid: 123 } }))
            .mockReturnValueOnce(of({ data: { errcode: 43004, errmsg: 'secret=private' } }))
            .mockReturnValueOnce(throwError(() => new Error('access_token=private')));
        expect(await api.sendTemplate({ touser: 'oa-a' } as any, 'token-a')).toEqual({ kind: 'accepted', msgId: '123' });
        expect(await api.sendTemplate({} as any, 'token-a')).toEqual({ kind: 'not_subscribed', code: 43004 });
        expect(await api.sendTemplate({} as any, 'token-a')).toEqual({ kind: 'unknown', code: 'TRANSPORT' });
    });

    it.each(['', '  '])('成功响应缺少有效 msgid 时保留 UNKNOWN：%j', async msgid => {
        http.post.mockReturnValue(of({ data: { errcode: 0, msgid } }));
        expect(await client().api.sendTemplate({} as any, 'token-a')).toEqual({ kind: 'unknown', code: 'INVALID_RESPONSE' });
    });
});
