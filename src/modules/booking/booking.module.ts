import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Booking, BookingSchema } from '../../entities/booking.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Booking.name, schema: BookingSchema }]),
    ],
    controllers: [BookingController],
    providers: [BookingService, BookingRepository],
    exports: [BookingService, BookingRepository],
})
export class BookingModule {}
