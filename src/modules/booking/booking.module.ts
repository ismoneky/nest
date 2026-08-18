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

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, AdminApplication, BookingAnomaly]),
    WechatPayModule,
    SystemConfigModule,
    UserModule,
    MemberModule,
    LoggingModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingRepository, AdminApplicationRepository],
  exports: [BookingService],
})
export class BookingModule {}
