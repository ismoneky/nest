import * as dotenv from 'dotenv';
import * as path from 'path';

export class ConfigService {
    private readonly envConfig: Record<string, string>;
    constructor() {
        // 根据 NODE_ENV 加载对应的环境配置文件
        const nodeEnv = process.env.NODE_ENV || 'development';
        const envFile = `.env.${nodeEnv}`;

        // 尝试加载特定环境的配置文件
        const result = dotenv.config({
            path: path.resolve(process.cwd(), envFile)
        });

        if (result.error) {
            // 如果特定环境文件不存在，尝试加载默认 .env 文件
            const fallbackResult = dotenv.config();
            if (fallbackResult.error) {
                console.warn(`Warning: No .env file found. Using process.env.`);
                this.envConfig = process.env as Record<string, string>;
            } else {
                this.envConfig = { ...process.env, ...fallbackResult.parsed } as Record<string, string>;
            }
        } else {
            this.envConfig = { ...process.env, ...result.parsed } as Record<string, string>;
        }

        console.log(`Loaded environment: ${nodeEnv}`);
    }

    public get(key: string): string {
        return this.envConfig[key];
    }

    public async getPortConfig() {
        return this.get('PORT');
    }

    public async getDatabaseConfig() {
        const dbPath = this.get('DATABASE_PATH') || 'data/app.db';
        const nodeEnv = this.get('NODE_ENV') || 'development';

        console.log('SQLite Database Path:', dbPath);

        return {
            type: 'sqlite' as const,
            database: dbPath,
            synchronize: nodeEnv !== 'production', // 生产环境禁用自动同步
            logging: this.get('DATABASE_LOGGING') === 'true',
        };
    }

    public getRedisConfig() {
        const host = this.get('REDIS_HOST') || 'localhost';
        const port = parseInt(this.get('REDIS_PORT'), 10) || 6379;
        const password = this.get('REDIS_PASSWORD');

        return {
            redis: {
                host,
                port,
                password,
            },
        };
    }

    public getCorsConfig() {
        const origin = this.get('CORS_ORIGIN') || '*';
        return {
            origin: origin === '*' ? '*' : origin.split(',').map(o => o.trim()),
            methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
            allowedHeaders: 'Content-Type, Accept, Authorization',
            credentials: origin !== '*', // 只有在指定具体域名时才允许携带凭证
        };
    }

    public getLogLevel() {
        return this.get('LOG_LEVEL') || 'info';
    }

    public isProduction(): boolean {
        return this.get('NODE_ENV') === 'production';
    }

    public isDevelopment(): boolean {
        return this.get('NODE_ENV') === 'development';
    }
}
