import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WechatPayService } from './wechat-pay.service';
import { WechatPayController } from './wechat-pay.controller';
import { Booking } from '../../entities/booking.entity';

/**
 * 微信支付模块
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Booking]),
    ],
    controllers: [WechatPayController],
    providers: [WechatPayService],
    exports: [WechatPayService],
})
export class WechatPayModule {}
