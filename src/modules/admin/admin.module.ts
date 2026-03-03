import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Admin, AdminSchema } from '../../entities/admin.entity';
import { AdminRepository } from '../../repositories/admin.repository';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
    imports: [MongooseModule.forFeature([{ name: Admin.name, schema: AdminSchema }])],
    controllers: [AdminController],
    providers: [AdminService, AdminRepository],
    exports: [AdminService, AdminRepository],
})
export class AdminModule {}
