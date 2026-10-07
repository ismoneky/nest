import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScenicGuide } from '../../entities/scenic-guide.entity';
import { ScenicGuideController } from './scenic-guide.controller';
import { ScenicGuideService } from './scenic-guide.service';
import { GuideUploadService } from './guide-upload.service';

@Module({
    imports: [TypeOrmModule.forFeature([ScenicGuide])],
    controllers: [ScenicGuideController],
    providers: [ScenicGuideService, GuideUploadService],
})
export class ScenicGuideModule {}
