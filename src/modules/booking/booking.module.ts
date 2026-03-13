import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../../entities/booking.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
    imports: [TypeOrmModule.forFeature([Booking])],
    controllers: [BookingController],
    providers: [BookingService, BookingRepository],
    exports: [BookingService, BookingRepository],
})
export class BookingModule {}
