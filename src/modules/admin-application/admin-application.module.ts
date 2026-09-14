import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminApplication } from '../../entities/admin-application.entity';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { AdminApplicationService } from './admin-application.service';
import { AdminApplicationController } from './admin-application.controller';
import { AdminApplicationAdminController } from './admin-application-admin.controller';
import { UserModule } from '../user/user.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([AdminApplication]),
        UserModule,
    ],
    controllers: [AdminApplicationController, AdminApplicationAdminController],
    providers: [AdminApplicationService, AdminApplicationRepository],
    exports: [AdminApplicationService],
})
export class AdminApplicationModule {}
