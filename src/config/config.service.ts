import * as dotenv from 'dotenv';

export class ConfigService {
    private readonly envConfig: Record<string, string>;
    constructor() {
        const result = dotenv.config();

        if (result.error) {
            this.envConfig = process.env;
        } else {
            this.envConfig = result.parsed;
        }
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
}
