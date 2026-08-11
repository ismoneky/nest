import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WechatPayService } from './wechat-pay.service';
import { WechatPayController } from './wechat-pay.controller';
import { Booking } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { LoggingModule } from '../logging/logging.module';

/**
 * 微信支付模块
 * BookingRepository 在本模块内单独注册（不使用 BookingModule 的导出，避免模块循环依赖），
 * 供回调路径调用转换协议条件更新（markPaymentSucceeded 等）。
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Booking, BookingAnomaly]),
        LoggingModule,
    ],
    controllers: [WechatPayController],
    providers: [WechatPayService, BookingRepository],
    exports: [WechatPayService],
})
export class WechatPayModule {}
