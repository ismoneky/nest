import { DataSource } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { User } from '../../entities/user.entity';
import { Message } from '../../entities/message.entity';
import { WechatOaFan } from '../../entities/wechat-oa-fan.entity';
import { WechatOaSyncRun } from '../../entities/wechat-oa-sync-run.entity';

it('生产升级 SQL 保留旧消息且新表列/索引与实体一致', async () => {
    const old = await new DataSource({ type: 'sqlite', database: ':memory:' }).initialize();
    const fresh = await new DataSource({ type: 'sqlite', database: ':memory:',
        entities: [User, Message, WechatOaFan, WechatOaSyncRun], synchronize: true }).initialize();
    try {
        await old.query('CREATE TABLE users (id integer PRIMARY KEY, wechatOpenId varchar)');
        await old.query('CREATE TABLE messages (id integer PRIMARY KEY, userId varchar, oaSendStatus integer DEFAULT 3, oaAttempts integer DEFAULT 0)');
        await old.query("INSERT INTO users VALUES (1, 'mini-old')");
        await old.query("INSERT INTO messages VALUES (1, 'mini-old', 3, 0)");
        const sql = readFileSync(join(__dirname, '../../../docs/deploy-2026-09-21-wechat-oa.sql'), 'utf8');
        await new Promise<void>((resolve, reject) => (old.driver as any).databaseConnection.exec(sql, err => err ? reject(err) : resolve()));
        expect((await old.query('SELECT oaSendStatus, oaPayloadJson FROM messages WHERE id = 1'))[0])
            .toEqual({ oaSendStatus: 3, oaPayloadJson: null });
        expect((await old.query('SELECT wechatUnionId, wechatIdentityConflict FROM users WHERE id = 1'))[0])
            .toEqual({ wechatUnionId: null, wechatIdentityConflict: 0 });
        for (const table of ['user_wx_oa', 'wx_oa_sync_runs']) {
            const columns = async (ds: DataSource) => (await ds.query(`PRAGMA table_info(${table})`))
                .map(({ name, type, notnull, dflt_value }) => ({ name, type: type.toLowerCase(), notnull, dflt_value }));
            expect(await columns(old)).toEqual(await columns(fresh));
        }
        for (const table of ['users', 'messages', 'user_wx_oa', 'wx_oa_sync_runs']) {
            const declared = (await old.query(`PRAGMA index_list(${table})`)).filter(i => i.name.startsWith('IDX_'));
            const expected = await fresh.query(`PRAGMA index_list(${table})`);
            for (const index of declared) expect(expected).toContainEqual(expect.objectContaining({ name: index.name, unique: index.unique }));
        }
    } finally { await old.destroy(); await fresh.destroy(); }
});
