import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppLog } from '../../entities/app-log.entity';
import { LoggingService } from './logging.service';
import { LoggingController } from './logging.controller';
import { requestIdMiddleware } from './request-context';
import { UserModule } from '../user/user.module';

/**
 * 轻量日志模块（独立 logs.db）
 * LoggingService 实现 AppLogWriter 接口，业务模块注入后记录日志；
 * 日志写入失败不影响预约/支付业务结果。
 * import UserModule：批量上报接口使用 JwtAuthGuard（JwtService 由 UserModule 提供）。
 */
@Module({
    imports: [TypeOrmModule.forFeature([AppLog], 'logs'), UserModule],
    controllers: [LoggingController],
    providers: [LoggingService],
    exports: [LoggingService],
})
export class LoggingModule implements NestModule {
    // requestId：每个请求生成关联标识并放入 AsyncLocalStorage，业务日志自动携带
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(requestIdMiddleware).forRoutes('*');
    }
}
