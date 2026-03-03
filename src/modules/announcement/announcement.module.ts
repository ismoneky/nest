import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Announcement, AnnouncementSchema } from '../../entities/announcement.entity';
import { AnnouncementRepository } from '../../repositories/announcement.repository';
import { AdminModule } from '../admin/admin.module';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';

@Module({
    imports: [MongooseModule.forFeature([{ name: Announcement.name, schema: AnnouncementSchema }]), AdminModule],
    controllers: [AnnouncementController],
    providers: [AnnouncementService, AnnouncementRepository],
    exports: [AnnouncementService],
})
export class AnnouncementModule {}
