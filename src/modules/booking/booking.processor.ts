import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable } from '@nestjs/common';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingStatus } from '../../entities/booking.entity';

@Processor('booking')
@Injectable()
export class BookingProcessor {
    constructor(private readonly bookingRepository: BookingRepository) {}

    @Process('completeBooking')
    async handleCompleteBooking(job: Job<{ bookingId: string }>) {
        const { bookingId } = job.data;
        await this.bookingRepository.updateBooking(bookingId, { status: BookingStatus.COMPLETED });
    }
}