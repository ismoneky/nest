import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config/config.service';
import { AdminModule } from './modules/admin/admin.module';
import { AdminApplicationModule } from './modules/admin-application/admin-application.module';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { BookingModule } from './modules/booking/booking.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { UserModule } from './modules/user/user.module';
import { WechatPayModule } from './modules/wechat-pay/wechat-pay.module';

// 导入所有实体
import { User } from './entities/user.entity';
import { Admin } from './entities/admin.entity';
import { Booking } from './entities/booking.entity';
import { Announcement } from './entities/announcement.entity';
import { SystemConfig } from './entities/system-config.entity';
import { AdminApplication } from './entities/admin-application.entity';

@Module({
    imports: [
        ConfigModule,
        // SQLite Connection with TypeORM
        TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            useFactory: async (configService: ConfigService) => ({
                ...(await configService.getDatabaseConfig()),
                entities: [User, Admin, Booking, Announcement, SystemConfig, AdminApplication],
            }),
        }),
        ScheduleModule.forRoot(),
        UserModule,
        BookingModule,
        AdminModule,
        AdminApplicationModule,
        AnnouncementModule,
        SystemConfigModule,
        WechatPayModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
