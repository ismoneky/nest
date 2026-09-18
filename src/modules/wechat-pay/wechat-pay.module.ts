import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WechatPayService } from './wechat-pay.service';
import { WechatPayController } from './wechat-pay.controller';
import { Booking } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { LoggingModule } from '../logging/logging.module';
import { RefundModule } from '../refund/refund.module';
import { MessageModule } from '../message/message.module';

/**
 * 微信支付模块
 * BookingRepository 在本模块内单独注册（不使用 BookingModule 的导出，避免模块循环依赖），
 * 供回调路径调用转换协议条件更新（markPaymentSucceeded 等）。
 * RefundModule 提供 RefundApplyRepository：退款回调落完订单终态后要把结果镜像到退款申请单。
 * MessageModule 提供 MessageService：退款到账后发站内信。**这条通知必须在本模块内发出**
 * ——回调路径走的是本服务私有的 `mirrorRefundSettlement`，不经过 `RefundApplyService`，
 * 写在那边的话真实回调路径上这条通知永远不会发出（详见 `MessageService.notifyRefundSettled`
 * 的注释）。MessageModule 是叶子模块，与 RefundModule 一样无环。
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Booking, BookingAnomaly]),
        LoggingModule,
        RefundModule,
        MessageModule,
    ],
    controllers: [WechatPayController],
    providers: [WechatPayService, BookingRepository],
    exports: [WechatPayService],
})
export class WechatPayModule {}
