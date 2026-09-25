import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity';
import { WechatOaFan } from '../../entities/wechat-oa-fan.entity';
import { WechatOaSyncRun } from '../../entities/wechat-oa-sync-run.entity';
import { WechatOaRepository } from '../../repositories/wechat-oa.repository';
import { WechatOaConfig } from './wechat-oa.config';
import { WechatOaClient } from './wechat-oa.client';
import { WechatOaTokenService } from './wechat-oa-token.service';
import { WechatOaFanSyncService } from './wechat-oa-fan-sync.service';
import { WechatOaController } from './wechat-oa.controller';
import { UserModule } from '../user/user.module';

@Module({
    imports: [HttpModule, TypeOrmModule.forFeature([User, WechatOaFan, WechatOaSyncRun]), UserModule],
    controllers: [WechatOaController],
    providers: [WechatOaConfig, WechatOaClient, WechatOaTokenService, WechatOaRepository, WechatOaFanSyncService],
    exports: [WechatOaConfig, WechatOaClient, WechatOaRepository],
})
export class WechatOaModule {}
