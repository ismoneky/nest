import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * 全局HTTP异常过滤器
 * 统一处理所有异常,防止未捕获异常导致服务器崩溃
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        let status = HttpStatus.INTERNAL_SERVER_ERROR;
        let message = 'Internal server error';
        let error = 'Internal Server Error';

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
        } else if (exception instanceof Error) {
            // 处理普通错误
            message = exception.message;
            error = exception.name;

            // 记录详细错误信息
            this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);
        } else {
            // 处理未知类型的异常
            this.logger.error(`Unknown exception type: ${JSON.stringify(exception)}`);
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
