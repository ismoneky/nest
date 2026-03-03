import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SystemConfig, SystemConfigSchema } from '../../entities/system-config.entity';
import { SystemConfigRepository } from '../../repositories/system-config.repository';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigService } from './system-config.service';

@Module({
    imports: [MongooseModule.forFeature([{ name: SystemConfig.name, schema: SystemConfigSchema }])],
    controllers: [SystemConfigController],
    providers: [SystemConfigService, SystemConfigRepository],
    exports: [SystemConfigService, SystemConfigRepository],
})
export class SystemConfigModule {}
