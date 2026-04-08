import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/user.entity';
import { AdminApplication } from '../../entities/admin-application.entity';
import { UserRepository } from '../../repositories/user.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([User, AdminApplication]),
        HttpModule,
        JwtModule.register({
            secret: process.env.JWT_SECRET || 'default_jwt_secret_change_in_production',
            signOptions: { expiresIn: '30d' },
        }),
    ],
    controllers: [UserController],
    providers: [UserService, UserRepository, AdminApplicationRepository],
    exports: [UserService, UserRepository, JwtModule],
})
export class UserModule {}
