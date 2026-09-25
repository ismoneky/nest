import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OA_FAN_SYNC_CRON, WechatOaConfig } from './wechat-oa.config';
import { WechatOaClient } from './wechat-oa.client';
import { WechatOaRepository } from '../../repositories/wechat-oa.repository';

@Injectable()
export class WechatOaFanSyncService {
    private running = false;
    private readonly logger = new Logger(WechatOaFanSyncService.name);
    constructor(private readonly config: WechatOaConfig, private readonly api: WechatOaClient,
        private readonly repo: WechatOaRepository) {}

    @Cron(OA_FAN_SYNC_CRON, { timeZone: 'Asia/Shanghai' })
    async scheduledSync(): Promise<void> {
        try { await this.sync(); } catch { this.logger.error('OA_SYNC_STORAGE_ERROR'); }
    }

    async sync(): Promise<{ status: string; runId?: string }> {
        if (!this.config.syncEnabled || !this.config.workerEnabled) return { status: 'DISABLED' };
        if (!this.config.credentialsReady()) return { status: 'CONFIG_INVALID' };
        if (this.running) return { status: 'RUNNING' };
        this.running = true;
        let run: Awaited<ReturnType<WechatOaRepository['startRun']>>;
        let success = 0, failure = 0;
        const seen = new Set<string>();
        try {
            run = await this.repo.startRun(this.config.appId, Date.now());
            let cursor = '', expectedTotal: number | undefined;
            const cursors = new Set<string>();
            for (;;) {
                if (Date.now() - run.startedAt > 5 * 60 * 1000 || cursors.size >= 1000) throw new Error('SYNC_BUDGET');
                if (cursors.has(cursor)) throw new Error('SYNC_CURSOR_LOOP');
                cursors.add(cursor);
                const page = await this.api.listFans(cursor);
                expectedTotal ??= page.total;
                // 变化中的名单保守放弃本轮退订对账，下一轮重新取完整快照。
                if (page.total !== expectedTotal || page.openids.some(id => seen.has(id))) throw new Error('SYNC_UNSTABLE_LIST');
                page.openids.forEach(id => seen.add(id));
                await this.repo.markSeen(this.config.appId, page.openids, run.runId, run.startedAt);
                const due = await this.repo.dueInfo(this.config.appId, page.openids, Date.now());
                for (let offset = 0; offset < due.length; offset += 100) {
                    if (Date.now() - run.startedAt > 5 * 60 * 1000) throw new Error('SYNC_BUDGET');
                    const ids = due.slice(offset, offset + 100), observedAt = Date.now();
                    let infos;
                    try { infos = await this.api.getFanInfo(ids); }
                    catch {
                        failure += ids.length;
                        await this.repo.deferInfo(this.config.appId, ids, observedAt);
                        continue;
                    }
                    await this.repo.applyInfo(this.config.appId, infos, observedAt);
                    success += ids.length;
                }
                await this.repo.progressRun(run.runId, page.next, seen.size);
                if (seen.size === expectedTotal) break;
                if (!page.openids.length || !page.next || seen.size > expectedTotal) throw new Error('SYNC_INCOMPLETE_LIST');
                cursor = page.next;
            }
            await this.repo.finishRun(run, seen.size, success, failure);
            this.logger.log(`OA_SYNC_COMPLETED seen=${seen.size} infoFailed=${failure}`);
            if (failure) this.logger.warn('OA_SYNC_PARTIAL_INFO_FAILURE');
            return { status: 'COMPLETED', runId: run.runId };
        } catch {
            if (run) await this.repo.failRun(run.runId, seen.size, success, failure);
            this.logger.error('OA_SYNC_INCOMPLETE：保留未扫描到的历史关注状态');
            return { status: 'FAILED', runId: run?.runId };
        } finally { this.running = false; }
    }
}
