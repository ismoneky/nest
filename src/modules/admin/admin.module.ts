import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin } from '../../entities/admin.entity';
import { AdminRepository } from '../../repositories/admin.repository';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BookingModule } from '../booking/booking.module';
import { RefundModule } from '../refund/refund.module';
import { UserModule } from '../user/user.module';
import { LoggingModule } from '../logging/logging.module';
import { MessageModule } from '../message/message.module';

/**
 * 依赖说明（四个 import 都是为了**直接**注入，不能靠传递）：
 *   · `UserModule` 提供 JwtModule —— AdminService 用它签发 adminToken（§4.3.4），
 *     AdminAuthGuard 用它验签；
 *   · `RefundModule` 提供 RefundApplyService —— 管理端审核退款申请；
 *   · `LoggingModule` 提供 LoggingService —— 审核操作写审计日志（§4.3.3）；
 *   · `MessageModule` 提供 MessageService —— 手动发站内信（§6）。
 *
 * ⚠️ `LoggingModule` 必须在这里列出，**不能指望从 `BookingModule` 传递过来**：
 * BookingModule 虽然 import 了 LoggingModule，但没有 re-export 它，
 * Nest 的模块可见性不会沿 import 链向上传递。漏掉它的表现是**应用启动即失败**
 * （`Nest can't resolve dependencies of the AdminService`），
 * 而不是运行到某条路径才报错——所以 `tsc` 与单元测试都发现不了，
 * 必须真的把应用启动一次（`src/app.module.spec.ts` 就是为此存在的）。
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Admin]),
        BookingModule,
        RefundModule,
        UserModule,
        LoggingModule,
        MessageModule,
    ],
    controllers: [AdminController],
    providers: [AdminService, AdminRepository],
    exports: [AdminService, AdminRepository],
})
export class AdminModule {}
