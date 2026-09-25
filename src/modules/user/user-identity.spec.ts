import { DataSource } from 'typeorm';
import { User } from '../../entities/user.entity';
import { UserRepository } from '../../repositories/user.repository';

describe('微信登录身份补齐', () => {
    let ds: DataSource;
    let repo: UserRepository;
    const login = (openid: string, unionid?: string) => repo.findOrCreateUser({
        wechatOpenId: openid, wechatUnionId: unionid,
    } as any);

    beforeEach(async () => {
        ds = await new DataSource({ type: 'sqlite', database: ':memory:', entities: [User], synchronize: true }).initialize();
        repo = new UserRepository(ds.getRepository(User));
    });
    afterEach(async () => ds.destroy());

    it('旧用户再次登录补 UnionID，缺失字段保留既有值', async () => {
        const old = await login('mini-a');
        const updated = await login('mini-a', 'union-a');
        expect(updated.userId).toBe(old.userId);
        expect((updated as any).wechatUnionId).toBe('union-a');
        expect((await login('mini-a') as any).wechatUnionId).toBe('union-a');
    });

    it('同一 OpenID 返回不同 UnionID 时冻结关联，仍可登录', async () => {
        await login('mini-a', 'union-a');
        const user: any = await login('mini-a', 'union-b');
        expect(user.wechatUnionId).toBe('union-a');
        expect(user.wechatIdentityConflict).toBe(1);
    });

    it('两个用户争用 UnionID 时冻结双方，不能串号', async () => {
        await login('mini-a', 'union-a');
        const second: any = await login('mini-b', 'union-a');
        expect(second.wechatUnionId).toBeNull();
        expect(second.wechatIdentityConflict).toBe(1);
        expect((await login('mini-a') as any).wechatIdentityConflict).toBe(1);
    });

    it('并发登录同一用户只创建一个业务身份', async () => {
        const users = await Promise.all(Array.from({ length: 5 }, () => login('mini-a', 'union-a')));
        expect(new Set(users.map(u => u.userId)).size).toBe(1);
        expect(await ds.getRepository(User).count()).toBe(1);
    });
});
