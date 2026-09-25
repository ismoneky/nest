import { filterContext } from './sensitive-filter';

it('服务号与小程序 UnionID 不进入结构化日志', () => {
    const result = filterContext({ action: 'oa-sync', unionId: 'union-private', wechatUnionId: 'mini-private',
        nested: { unionid: 'nested-private', oaOpenId: 'openid-private', access_token: 'token-private' } });
    expect(result.json).toBe(JSON.stringify({ action: 'oa-sync', nested: {} }));
});
