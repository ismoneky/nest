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
import { BookingAnomaly } from './entities/booking-anomaly.entity';
import { AppLog } from './entities/app-log.entity';
import { LoggingModule } from './modules/logging/logging.module';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { APP_FILTER } from '@nestjs/core';

@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'sqlite',
            database: process.env.DATABASE_PATH || 'data/app.db',
            // 生产环境（NODE_ENV=production）synchronize=false：schema 变更通过手工 SQL 执行，
            // SQL 见 docs/implementation-todo.md「生产 schema 变更 SQL（手工执行）」
            synchronize: process.env.NODE_ENV !== 'production',
            logging: process.env.DATABASE_LOGGING === 'true',
            entities: [User, UserProfile, Admin, Booking, Announcement, SystemConfig, AdminApplication, Feedback, Member, BookingAnomaly],
            // busyTimeout：写锁冲突时等待 5 秒而非立即报错。
            // sqlite3 驱动只识别顶层 enableWAL/busyTimeout，extra.pragma 写法不生效
            // （此前 busy_timeout 实际为 0，2026-08-16 12:31 事务报错后修正，
            // 见 docs/implementation-todo.md「TYPEORM_PRAGMA_CONFIGURATION_IGNORED」）；
            // WAL 与 synchronous 按支付可靠性设计暂不启用，另行验证后决策。
            busyTimeout: 5000,
        }),
        // 日志库独立 DataSource（logs.db）：只注册 AppLog，synchronize 无条件关闭，
        // 建表走手工 SQL（docs/implementation-todo.md「生产 schema 变更 SQL」第 5 节）
        TypeOrmModule.forRoot({
            name: 'logs',
            type: 'sqlite',
            database: process.env.LOG_DATABASE_PATH || 'data/logs.db',
            synchronize: false,
            logging: process.env.DATABASE_LOGGING === 'true',
            entities: [AppLog],
        }),
        ScheduleModule.forRoot(),
        LoggingModule,
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
    providers: [
        AppService,
        // 全局异常过滤器（可注入日志服务，未处理异常写入 app_logs）
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ],
})
export class AppModule {}
