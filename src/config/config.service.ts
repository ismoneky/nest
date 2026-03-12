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

    public async getMongoConfig() {
        const user = this.get('MONGO_USER');
        const password = this.get('MONGO_PASSWORD');
        const host = this.get('MONGO_HOST');
        const database = this.get('MONGO_DATABASE');

        // 连接池配置,防止连接泄漏
        const connectionOptions = {
            maxPoolSize: 50, // 最大连接池大小
            minPoolSize: 5, // 最小连接池大小
            maxIdleTimeMS: 30000, // 连接最大空闲时间 30秒
            serverSelectionTimeoutMS: 5000, // 服务器选择超时 5秒
            socketTimeoutMS: 45000, // Socket 超时 45秒
            family: 4, // 使用 IPv4
        };

        // 如果用户名或密码未定义, 使用无认证连接
        const uri = !user || !password
            ? `mongodb://${host}/${database}`
            : host.includes('mongodb.net')
            ? `mongodb+srv://${user}:${password}@${host}/${database}`
            : `mongodb://${user}:${password}@${host}/${database}?authSource=admin`;

        console.log('MongoDB Connection URI:', uri);

        return {
            uri,
            ...connectionOptions,
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
