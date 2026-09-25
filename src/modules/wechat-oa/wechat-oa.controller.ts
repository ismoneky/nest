import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { WechatOaConfig } from './wechat-oa.config';
import { WechatOaFanSyncService } from './wechat-oa-fan-sync.service';
import { WechatOaRepository } from '../../repositories/wechat-oa.repository';

/** 仅管理员运维接口；不存在服务号回调或匿名手动推送接口。 */
@Controller('admin/wechat-oa')
@UseGuards(AdminAuthGuard)
export class WechatOaController {
    constructor(private readonly config: WechatOaConfig, private readonly syncService: WechatOaFanSyncService,
        private readonly repo: WechatOaRepository) {}

    @Post('sync')
    @HttpCode(200)
    async sync() {
        const data = await this.syncService.sync();
        return { success: data.status === 'COMPLETED', data };
    }

    @Get('status')
    async status() {
        const status = await this.repo.status(this.config.appId);
        return { success: true, data: { ...status, syncEnabled: this.config.syncEnabled, sendEnabled: this.config.sendEnabled,
            workerEnabled: this.config.workerEnabled, credentialsReady: this.config.credentialsReady(),
            templateReadiness: this.config.templateReadiness(),
            syncStale: !status.lastCompletedAt || Date.now() - status.lastCompletedAt > 4 * 3600000 } };
    }
}
