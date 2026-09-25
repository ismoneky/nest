import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { WechatOaFan } from '../entities/wechat-oa-fan.entity';
import { WechatOaSyncRun } from '../entities/wechat-oa-sync-run.entity';
import { User } from '../entities/user.entity';
import { serialTransaction, serialWrite } from '../common/transaction-runner';
import { OaFanInfo } from '../modules/wechat-oa/wechat-oa.types';

export type OaRecipient = { kind: 'ready'; openid: string } | { kind: 'waiting' | 'conflict' | 'unsubscribed' };

@Injectable()
export class WechatOaRepository {
    constructor(@InjectRepository(WechatOaFan) private readonly fans: Repository<WechatOaFan>,
        @InjectRepository(WechatOaSyncRun) private readonly runs: Repository<WechatOaSyncRun>,
        @InjectRepository(User) private readonly users: Repository<User>) {}

    async startRun(oaAppId: string, now: number): Promise<WechatOaSyncRun> {
        return serialTransaction(this.fans.manager.connection, async em => {
            const repo = em.getRepository(WechatOaSyncRun);
            // 只允许单个调度执行者；上一进程留下的 RUNNING 不算完成扫描。
            await repo.update({ oaAppId, status: 'RUNNING' }, { status: 'FAILED', completedAt: now, lastError: 'PROCESS_INTERRUPTED' });
            return repo.save(repo.create({ runId: randomUUID(), oaAppId, status: 'RUNNING', startedAt: now }));
        });
    }

    async markSeen(oaAppId: string, ids: string[], runId: string, observedAt: number): Promise<void> {
        for (let offset = 0; offset < ids.length; offset += 100) {
            await serialTransaction(this.fans.manager.connection, async em => {
                const repo = em.getRepository(WechatOaFan);
                for (const oaOpenId of ids.slice(offset, offset + 100)) {
                    let fan = await repo.findOneBy({ oaAppId, oaOpenId });
                    if (!fan) fan = repo.create({ oaAppId, oaOpenId, unionId: null, identityConflict: 0,
                        subscribed: 1, subscriptionObservedAt: observedAt, createdAt: Date.now(), infoAttempts: 0 });
                    if (fan.subscriptionObservedAt <= observedAt) {
                        fan.subscribed = 1; fan.subscriptionObservedAt = observedAt;
                    }
                    fan.lastSeenRunId = runId; fan.updatedAt = Date.now();
                    await repo.save(fan);
                }
            });
        }
    }

    async dueInfo(oaAppId: string, ids: string[], now: number): Promise<string[]> {
        const due: string[] = [];
        for (let i = 0; i < ids.length; i += 100) {
            const rows = await this.fans.findBy({ oaAppId, oaOpenId: In(ids.slice(i, i + 100)) });
            due.push(...rows.filter(f => !f.unionId && !f.identityConflict && (!f.nextInfoRetryAt || f.nextInfoRetryAt <= now)).map(f => f.oaOpenId));
        }
        return due;
    }

    async applyInfo(oaAppId: string, infos: OaFanInfo[], observedAt: number): Promise<void> {
        await serialTransaction(this.fans.manager.connection, async em => {
            const repo = em.getRepository(WechatOaFan);
            for (const info of infos) {
                const fan = await repo.findOneBy({ oaAppId, oaOpenId: info.openid });
                if (!fan) continue;
                if (fan.subscriptionObservedAt <= observedAt) {
                    fan.subscribed = info.subscribe; fan.subscriptionObservedAt = observedAt;
                }
                if (info.unionid) {
                    const owner = await repo.findOneBy({ oaAppId, unionId: info.unionid });
                    if ((fan.unionId && fan.unionId !== info.unionid) || (owner && owner.id !== fan.id)) {
                        fan.identityConflict = 1;
                        if (owner && owner.id !== fan.id) await repo.update(owner.id, { identityConflict: 1, updatedAt: Date.now() });
                    } else if (!fan.identityConflict) fan.unionId = info.unionid;
                }
                fan.lastInfoAt = observedAt; fan.updatedAt = Date.now();
                fan.infoAttempts = fan.unionId ? 0 : fan.infoAttempts + 1;
                fan.nextInfoRetryAt = fan.unionId ? null : this.nextInfoRetry(fan.infoAttempts, observedAt);
                await repo.save(fan);
            }
        });
    }

    async deferInfo(oaAppId: string, ids: string[], now: number): Promise<void> {
        await serialTransaction(this.fans.manager.connection, async em => {
            const repo = em.getRepository(WechatOaFan);
            const rows = await repo.findBy({ oaAppId, oaOpenId: In(ids) });
            for (const row of rows) {
                row.infoAttempts++; row.nextInfoRetryAt = this.nextInfoRetry(row.infoAttempts, now); row.updatedAt = now;
                await repo.save(row);
            }
        });
    }

    private nextInfoRetry(attempts: number, now: number): number {
        return now + Math.min(24, 2 * 2 ** Math.min(attempts - 1, 4)) * 60 * 60 * 1000;
    }

    async progressRun(runId: string, lastCursor: string, seenCount: number): Promise<void> {
        await serialWrite(this.runs.manager.connection, () => this.runs.update(runId, { lastCursor, seenCount }));
    }

    async finishRun(run: WechatOaSyncRun, seenCount: number, infoSuccessCount: number, infoFailureCount: number): Promise<void> {
        await serialTransaction(this.fans.manager.connection, async em => {
            await em.createQueryBuilder().update(WechatOaFan).set({ subscribed: 0, subscriptionObservedAt: run.startedAt, updatedAt: Date.now() })
                .where('oaAppId = :appId', { appId: run.oaAppId }).andWhere('lastSeenRunId != :runId', { runId: run.runId })
                .andWhere('subscriptionObservedAt <= :observed', { observed: run.startedAt }).execute();
            await em.update(WechatOaSyncRun, run.runId, { status: 'COMPLETED', completedAt: Date.now(), seenCount,
                infoSuccessCount, infoFailureCount, lastError: infoFailureCount ? 'PARTIAL_INFO_FAILURE' : null });
        });
    }

    async failRun(runId: string, seenCount: number, infoSuccessCount: number, infoFailureCount: number): Promise<void> {
        await serialWrite(this.runs.manager.connection, () => this.runs.update(runId, { status: 'FAILED', completedAt: Date.now(),
            seenCount, infoSuccessCount, infoFailureCount, lastError: 'SYNC_INCOMPLETE' }));
    }

    async markUnsubscribed(oaAppId: string, oaOpenId: string, observedAt: number): Promise<void> {
        await serialWrite(this.fans.manager.connection, () => this.fans.createQueryBuilder().update(WechatOaFan)
            .set({ subscribed: 0, subscriptionObservedAt: observedAt, updatedAt: Date.now() })
            .where('oaAppId = :oaAppId AND oaOpenId = :oaOpenId', { oaAppId, oaOpenId })
            .andWhere('subscriptionObservedAt <= :observedAt', { observedAt }).execute());
    }

    async resolveRecipient(miniOpenId: string, oaAppId: string): Promise<OaRecipient> {
        const user = await this.users.findOneBy({ wechatOpenId: miniOpenId });
        if (!user) return { kind: 'waiting' };
        if (user.wechatIdentityConflict) return { kind: 'conflict' };
        if (!user.wechatUnionId) return { kind: 'waiting' };
        const fan = await this.fans.findOneBy({ oaAppId, unionId: user.wechatUnionId });
        if (!fan) return { kind: 'waiting' };
        if (fan.identityConflict) return { kind: 'conflict' };
        if (!fan.subscribed) return { kind: 'unsubscribed' };
        if (!await this.runs.existsBy({ oaAppId, status: 'COMPLETED' })) return { kind: 'waiting' };
        return { kind: 'ready', openid: fan.oaOpenId };
    }

    async status(oaAppId: string) {
        const [latest, complete, subscribed, missingUnionId] = await Promise.all([
            this.runs.findOne({ where: { oaAppId }, order: { startedAt: 'DESC' } }),
            this.runs.findOne({ where: { oaAppId, status: 'COMPLETED' }, order: { startedAt: 'DESC' } }),
            this.fans.countBy({ oaAppId, subscribed: 1 }),
            this.fans.createQueryBuilder('f').where('f.oaAppId = :oaAppId AND f.subscribed = 1 AND f.unionId IS NULL', { oaAppId }).getCount(),
        ]);
        // 不返回游标（OpenID）或原始微信响应。
        return { latest: latest ? { runId: latest.runId, status: latest.status, startedAt: latest.startedAt,
            completedAt: latest.completedAt, seenCount: latest.seenCount, infoFailureCount: latest.infoFailureCount, lastError: latest.lastError } : null,
            lastCompletedAt: complete?.completedAt ?? null, subscribed, missingUnionId };
    }
}
