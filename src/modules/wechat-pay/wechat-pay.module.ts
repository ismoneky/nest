import { Module } from '@nestjs/common';
import { WechatPayService } from './wechat-pay.service';
import { WechatPayController } from './wechat-pay.controller';
import { ConfigModule } from '../../config/config.module';
import { BookingModule } from '../booking/booking.module';

/**
 * 微信支付模块
 */
@Module({
    imports: [
        ConfigModule,
        BookingModule,
    ],
    controllers: [WechatPayController],
    providers: [WechatPayService],
    exports: [WechatPayService],
})
export class WechatPayModule {}
