import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bull';
import { Booking, BookingSchema } from '../../entities/booking.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BookingProcessor } from './booking.processor';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Booking.name, schema: BookingSchema }]),
        BullModule.registerQueue({
            name: 'booking',
        }),
    ],
    controllers: [BookingController],
    providers: [BookingService, BookingRepository, BookingProcessor],
    exports: [BookingService, BookingRepository],
})
export class BookingModule {}
