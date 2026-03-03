import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional } from 'class-validator';
import { BookingStatus } from '../../../entities/booking.entity';
import { CreateBookingDto } from './createBooking.dto';

export class UpdateBookingDto extends PartialType(CreateBookingDto) {
    @IsEnum(BookingStatus)
    @IsOptional()
    status?: BookingStatus;
}
