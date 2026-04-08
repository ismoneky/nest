import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WechatPayService } from './wechat-pay.service';
import { WechatPayController } from './wechat-pay.controller';
import { ConfigModule } from '../../config/config.module';
import { Booking } from '../../entities/booking.entity';

/**
 * 微信支付模块
 */
@Module({
    imports: [
        ConfigModule,
        TypeOrmModule.forFeature([Booking]),
    ],
    controllers: [WechatPayController],
    providers: [WechatPayService],
    exports: [WechatPayService],
})
export class WechatPayModule {}
