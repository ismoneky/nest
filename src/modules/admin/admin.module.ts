import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin } from '../../entities/admin.entity';
import { AdminRepository } from '../../repositories/admin.repository';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BookingModule } from '../booking/booking.module';

@Module({
    imports: [TypeOrmModule.forFeature([Admin]), BookingModule],
    controllers: [AdminController],
    providers: [AdminService, AdminRepository],
    exports: [AdminService, AdminRepository],
})
export class AdminModule {}
