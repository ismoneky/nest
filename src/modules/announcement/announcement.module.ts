import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Announcement } from '../../entities/announcement.entity';
import { AnnouncementRepository } from '../../repositories/announcement.repository';
import { AdminModule } from '../admin/admin.module';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';

@Module({
    imports: [TypeOrmModule.forFeature([Announcement]), AdminModule],
    controllers: [AnnouncementController],
    providers: [AnnouncementService, AnnouncementRepository],
    exports: [AnnouncementService],
})
export class AnnouncementModule {}
