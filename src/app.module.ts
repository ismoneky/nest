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
            // WAL 模式：读写不互斥，显著提升并发性能
            // busy_timeout：写锁冲突时等待 5 秒而非立即报错
            // synchronous=NORMAL：WAL 模式下安全且更快的同步级别
            extra: {
                pragma: [
                    'journal_mode = WAL',
                    'busy_timeout = 5000',
                    'synchronous = NORMAL',
                ],
            },
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
