import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../../entities/booking.entity';
import { AdminApplication } from '../../entities/admin-application.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { WechatPayModule } from '../wechat-pay/wechat-pay.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { UserModule } from '../user/user.module';
import { MemberModule } from '../member/member.module';
import { LoggingModule } from '../logging/logging.module';
import { RefundModule } from '../refund/refund.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, AdminApplication, BookingAnomaly]),
    WechatPayModule,
    SystemConfigModule,
    UserModule,
    MemberModule,
    LoggingModule,
    // 退款申请单：BookingService 注入 RefundApplyRepository 做资金结果镜像。
    // 单向依赖（RefundModule 不 import 本模块），无环。
    RefundModule,
    // 站内信：T1 步骤② / T2 每日提醒的发送出口。MessageModule 是叶子模块
    // （只依赖 TypeOrmModule.forFeature([Message]) 与 UserModule），无环。
    MessageModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingRepository, AdminApplicationRepository],
  exports: [BookingService],
})
export class BookingModule {}
