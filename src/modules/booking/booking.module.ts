import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../../entities/booking.entity';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BookingRepository } from '../../repositories/booking.repository';
import { WechatPayModule } from '../wechat-pay/wechat-pay.module';
import { SystemConfigModule } from '../system-config/system-config.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking]),
    WechatPayModule,
    SystemConfigModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingRepository],
  exports: [BookingService],
})
export class BookingModule {}
