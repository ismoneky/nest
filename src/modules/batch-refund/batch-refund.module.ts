import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BatchRefundTask } from '../../entities/batch-refund-task.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BatchRefundTaskRepository } from '../../repositories/batch-refund-task.repository';
import { WechatPayModule } from '../wechat-pay/wechat-pay.module';
import { LoggingModule } from '../logging/logging.module';
import { BatchRefundService } from './batch-refund.service';
import { BatchRefundController } from './batch-refund.controller';

/**
 * 批量退款模块
 * BookingRepository 在本模块内单独注册（与 WechatPayModule 同法，避免模块循环依赖）。
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Booking, BookingAnomaly, BatchRefundTask]),
        WechatPayModule,
        LoggingModule,
    ],
    controllers: [BatchRefundController],
    providers: [BatchRefundService, BookingRepository, BatchRefundTaskRepository],
    exports: [BatchRefundService],
})
export class BatchRefundModule {}
