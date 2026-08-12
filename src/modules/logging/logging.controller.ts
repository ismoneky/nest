import { Body, Controller, Get, HttpStatus, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';
import { LoggingService, LogEntry } from './logging.service';

/**
 * 批量上报 DTO（单次最多 20 条，请求体最大 192 KiB 由 bodyParser 限制）
 */
class ClientLogDto {
    @IsString()
    logId: string;

    @IsEnum(AppLogLevel)
    level: AppLogLevel;

    @IsEnum(AppLogCategory)
    category: AppLogCategory;

    @IsString()
    @MaxLength(2000)
    message: string;

    @IsOptional()
    @IsString()
    sessionId?: string;

    @IsOptional()
    @IsString()
    route?: string;

    @IsOptional()
    context?: unknown;

    @IsOptional()
    @IsString()
    appVersion?: string;

    @IsOptional()
    @IsString()
    platform?: string;

    @IsOptional()
    @IsInt()
    clientCreatedAt?: number;
}

class ClientLogsBatchDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ClientLogDto)
    logs: ClientLogDto[];

    /** 队列淘汰/拒绝累计计数（客户端携带，服务端接受后由客户端清零） */
    @IsOptional()
    @IsInt()
    @Min(0)
    droppedLogCount?: number;
}

/**
 * 管理查询 DTO
 */
class QueryLogsDto {
    @IsOptional()
    @IsEnum(AppLogSource)
    source?: AppLogSource;

    @IsOptional()
    @IsEnum(AppLogLevel)
    level?: AppLogLevel;

    @IsOptional()
    @IsEnum(AppLogCategory)
    category?: AppLogCategory;

    @IsOptional()
    @IsString()
    keyword?: string;

    /** YYYY-MM-DD */
    @IsOptional()
    @IsString()
    start?: string;

    /** YYYY-MM-DD */
    @IsOptional()
    @IsString()
    end?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    pageSize?: number;
}

/**
 * 日志接口：小程序批量上报 + 管理后台查询/统计
 */
@Controller()
export class LoggingController {
    private readonly logger = new Logger(LoggingController.name);

    /** 每用户/会话每分钟最多 6 个批次 */
    private static readonly RATE_LIMIT_PER_MINUTE = 6;
    private readonly rateBuckets = new Map<string, { count: number; windowStart: number }>();

    constructor(private readonly loggingService: LoggingService) {}

    /**
     * 小程序批量上报
     * POST /client-logs/batch
     * 单次最多 20 条；writer 繁忙/超时返回 503，客户端保留日志并退避；
     * 4xx 表示日志格式不可接受，客户端删除对应无效日志
     */
    @Post('client-logs/batch')
    @UseGuards(JwtAuthGuard)
    async submitClientBatch(@Body() body: ClientLogsBatchDto, @Req() req: Request, @Res() res: Response) {
        const openid = (req['user'] as any)?.openid ?? 'anonymous';
        if (!this.checkRateLimit(openid)) {
            return res.status(HttpStatus.TOO_MANY_REQUESTS).send({
                success: false,
                message: '日志上报过于频繁，请稍后重试',
                errorCode: 'LOG_RATE_LIMITED',
            });
        }

        if (!body.logs || body.logs.length === 0) {
            return res.status(HttpStatus.BAD_REQUEST).send({ success: false, message: 'logs 不能为空' });
        }
        if (body.logs.length > 20) {
            return res.status(HttpStatus.BAD_REQUEST).send({ success: false, message: '单批最多 20 条日志' });
        }

        const entries: LogEntry[] = body.logs.map((log) => ({
            source: AppLogSource.MINIPROGRAM,
            level: log.level,
            category: log.category,
            message: log.message,
            logId: log.logId,
            sessionId: log.sessionId,
            route: log.route,
            context: log.context,
            appVersion: log.appVersion,
            platform: log.platform,
            clientCreatedAt: log.clientCreatedAt,
        }));

        try {
            const { acceptedLogIds } = await this.loggingService.persistClientBatch(entries);
            return res.status(HttpStatus.OK).send({
                success: true,
                data: { acceptedLogIds, rejected: [] },
            });
        } catch (error) {
            // writer 繁忙/队列满/超时：503，客户端保留原日志并递增退避
            return res.status(HttpStatus.SERVICE_UNAVAILABLE).send({
                success: false,
                message: '日志写入繁忙，请稍后重试',
                errorCode: 'LOG_WRITE_BUSY',
            });
        }
    }

    /**
     * 管理后台日志查询
     * GET /admin/logs，默认按 createdAt DESC, id DESC 排序
     */
    @Get('admin/logs')
    @UseGuards(AdminAuthGuard)
    async queryLogs(@Query() query: QueryLogsDto, @Res() res: Response) {
        try {
            const page = query.page ?? 1;
            const pageSize = Math.min(query.pageSize ?? 20, 100);

            const qb = this.loggingService.queryLogsBuilder();
            if (query.source) qb.andWhere('log.source = :source', { source: query.source });
            if (query.level) qb.andWhere('log.level = :level', { level: query.level });
            if (query.category) qb.andWhere('log.category = :category', { category: query.category });
            if (query.keyword) {
                qb.andWhere('(log.message LIKE :kw OR log.route LIKE :kw OR log.logId LIKE :kw)', { kw: `%${query.keyword}%` });
            }
            if (query.start) {
                const start = new Date(query.start);
                start.setHours(0, 0, 0, 0);
                qb.andWhere('log.createdAt >= :start', { start: start.getTime() });
            }
            if (query.end) {
                const end = new Date(query.end);
                end.setHours(23, 59, 59, 999);
                qb.andWhere('log.createdAt <= :end', { end: end.getTime() });
            }

            const [logs, total] = await qb
                .orderBy('log.createdAt', 'DESC')
                .addOrderBy('log.id', 'DESC')
                .skip((page - 1) * pageSize)
                .take(pageSize)
                .getManyAndCount();

            return res.status(HttpStatus.OK).send({
                success: true,
                data: {
                    logs,
                    total,
                    page,
                    pageSize,
                    totalPages: Math.ceil(total / pageSize),
                },
            });
        } catch (error) {
            return res.status(HttpStatus.BAD_REQUEST).send({ success: false, message: '查询日志失败', error: error.message });
        }
    }

    /**
     * 管理后台日志基础统计
     * GET /admin/logs/stats?start=&end=
     */
    @Get('admin/logs/stats')
    @UseGuards(AdminAuthGuard)
    async logStats(@Query() query: QueryLogsDto, @Res() res: Response) {
        try {
            const stats = await this.loggingService.computeStats(query.start, query.end);
            return res.status(HttpStatus.OK).send({ success: true, data: stats });
        } catch (error) {
            return res.status(HttpStatus.BAD_REQUEST).send({ success: false, message: '获取日志统计失败', error: error.message });
        }
    }

    /**
     * 每用户/会话每分钟最多 6 个批次的简单限流（进程内）
     */
    private checkRateLimit(openid: string): boolean {
        const now = Date.now();
        const windowMs = 60 * 1000;
        const bucket = this.rateBuckets.get(openid);
        if (!bucket || now - bucket.windowStart >= windowMs) {
            this.rateBuckets.set(openid, { count: 1, windowStart: now });
            // 简单防增长：超过 1000 个用户时清空旧桶
            if (this.rateBuckets.size > 1000) {
                for (const [key, b] of this.rateBuckets) {
                    if (now - b.windowStart >= windowMs) {
                        this.rateBuckets.delete(key);
                    }
                }
            }
            return true;
        }
        bucket.count++;
        return bucket.count <= LoggingController.RATE_LIMIT_PER_MINUTE;
    }
}
