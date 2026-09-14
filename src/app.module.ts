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
import { RefundModule } from './modules/refund/refund.module';
import { MessageModule } from './modules/message/message.module';
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
import { RefundApply } from './entities/refund-apply.entity';
import { Message } from './entities/message.entity';
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
            // 没有 autoLoadEntities：实体必须在这里显式列出，漏了不会报错，
            // 只会在运行到那条查询时说「表不存在」
            entities: [User, UserProfile, Admin, Booking, Announcement, SystemConfig, AdminApplication, Feedback, Member, BookingAnomaly, RefundApply, Message],
            // busyTimeout：写锁冲突时等待 5 秒而非立即报错。
            // sqlite3 驱动只识别顶层 enableWAL/busyTimeout，extra.pragma 写法不生效
            // （此前 busy_timeout 实际为 0，2026-08-16 12:31 事务报错后修正，
            // 见 docs/implementation-todo.md「TYPEORM_PRAGMA_CONFIGURATION_IGNORED」）；
            // WAL 与 synchronous 按支付可靠性设计暂不启用，另行验证后决策。
            //
            // 注意 busyTimeout 只对「其它连接持锁」有效：sqlite 驱动全进程共用一条连接，
            // 进程内并发的事务之间根本不会走到这个等待。进程内并发由
            // src/common/transaction-runner.ts 串行化（2026-09-13 线上事故的修复）。
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
            // 与主库同款：写锁冲突时等 5 秒而不是立即报错（此前这条漏了，日志清理事务
            // 与应用侧写日志撞锁时会直接失败）。logs.db 只有 runLogCleanup 一处事务，
            // 不存在主库那种进程内并发事务问题，故无需走 transaction-runner。
            busyTimeout: 5000,
        }),
        ScheduleModule.forRoot(),
        LoggingModule,
        UserModule,
        BookingModule,
        RefundModule,
        AdminModule,
        AdminApplicationModule,
        AnnouncementModule,
        SystemConfigModule,
        WechatPayModule,
        FeedbackModule,
        MemberModule,
        MessageModule,
    ],
    controllers: [AppController],
    providers: [
        AppService,
        // 全局异常过滤器（可注入日志服务，未处理异常写入 app_logs）
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ],
})
export class AppModule {}
