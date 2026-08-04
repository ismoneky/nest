import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './modules/admin/admin.module';
import { AdminApplicationModule } from './modules/admin-application/admin-application.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { MemberModule } from './modules/member/member.module';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { BookingModule } from './modules/booking/booking.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { UserModule } from './modules/user/user.module';
import { WechatPayModule } from './modules/wechat-pay/wechat-pay.module';

// 导入所有实体
import { User } from './entities/user.entity';
import { UserProfile } from './entities/user-profile.entity';
import { Admin } from './entities/admin.entity';
import { Booking } from './entities/booking.entity';
import { Announcement } from './entities/announcement.entity';
import { SystemConfig } from './entities/system-config.entity';
import { AdminApplication } from './entities/admin-application.entity';
import { Feedback } from './entities/feedback.entity';
import { Member } from './entities/member.entity';

@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'sqlite',
            database: process.env.DATABASE_PATH || 'data/app.db',
            synchronize: process.env.NODE_ENV !== 'production',
            logging: process.env.DATABASE_LOGGING === 'true',
            entities: [User, UserProfile, Admin, Booking, Announcement, SystemConfig, AdminApplication, Feedback, Member],
        }),
        ScheduleModule.forRoot(),
        UserModule,
        BookingModule,
        AdminModule,
        AdminApplicationModule,
        AnnouncementModule,
        SystemConfigModule,
        WechatPayModule,
        FeedbackModule,
        MemberModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
