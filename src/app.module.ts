import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config/config.service';
import { AdminModule } from './modules/admin/admin.module';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { BookingModule } from './modules/booking/booking.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { UserModule } from './modules/user/user.module';

// 导入所有实体
import { User } from './entities/user.entity';
import { Admin } from './entities/admin.entity';
import { Booking } from './entities/booking.entity';
import { Announcement } from './entities/announcement.entity';
import { SystemConfig } from './entities/system-config.entity';

@Module({
    imports: [
        ConfigModule,
        // SQLite Connection with TypeORM
        TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            useFactory: async (configService: ConfigService) => ({
                ...(await configService.getDatabaseConfig()),
                entities: [User, Admin, Booking, Announcement, SystemConfig],
            }),
        }),
        ScheduleModule.forRoot(),
        UserModule,
        BookingModule,
        AdminModule,
        AnnouncementModule,
        SystemConfigModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
