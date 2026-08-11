import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { LoggingService } from '../modules/logging/logging.service';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../entities/app-log.entity';

/**
 * 全局HTTP异常过滤器
 * 统一处理所有异常,防止未捕获异常导致服务器崩溃
 * 未处理异常（非 HTTP 异常或 5xx）记录到日志系统（app_logs，category=runtime），
 * 日志写入失败只输出 Nest 原生日志，不会递归写入 app_logs
 */
@Injectable()
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    constructor(private readonly loggingService?: LoggingService) {}

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        let status = HttpStatus.INTERNAL_SERVER_ERROR;
        let message = 'Internal server error';
        let error = 'Internal Server Error';
        let isUnhandled = false;

        // 处理 HTTP 异常
        if (exception instanceof HttpException) {
            status = exception.getStatus();
            const exceptionResponse = exception.getResponse();

            if (typeof exceptionResponse === 'string') {
                message = exceptionResponse;
            } else if (typeof exceptionResponse === 'object') {
                const responseObj = exceptionResponse as any;
                message = responseObj.message || message;
                error = responseObj.error || error;
            }
            // 仅 5xx 视为需要记录的未处理异常；4xx 属于正常业务分支，不记录
            isUnhandled = status >= 500;
        } else if (exception instanceof Error) {
            // 处理普通错误
            message = exception.message;
            error = exception.name;
            isUnhandled = true;

            // 记录详细错误信息
            this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);
        } else {
            // 处理未知类型的异常
            this.logger.error(`Unknown exception type: ${JSON.stringify(exception)}`);
            isUnhandled = true;
        }

        // 未处理异常写入日志系统（失败不影响响应）
        if (isUnhandled && this.loggingService) {
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.ERROR,
                category: AppLogCategory.RUNTIME,
                message: `未处理异常: ${message}`,
                route: request.url,
                context: { status, error, method: request.method },
            }).catch(() => {
                // 日志失败只输出原生日志，不改变业务响应
                this.logger.warn('未处理异常写入日志系统失败');
            });
        }

        // 返回统一的错误响应
        response.status(status).json({
            success: false,
            statusCode: status,
            error,
            message,
            path: request.url,
            timestamp: new Date().toISOString(),
        });
    }
}
