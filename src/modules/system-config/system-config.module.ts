import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemConfig } from '../../entities/system-config.entity';
import { SystemConfigRepository } from '../../repositories/system-config.repository';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigService } from './system-config.service';

@Module({
    imports: [TypeOrmModule.forFeature([SystemConfig])],
    controllers: [SystemConfigController],
    providers: [SystemConfigService, SystemConfigRepository],
    exports: [SystemConfigService, SystemConfigRepository],
})
export class SystemConfigModule {}
