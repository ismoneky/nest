import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SystemConfigService } from '../src/modules/system-config/system-config.service';

/**
 * 初始化系统配置脚本
 * 运行方式: npm run init-config
 */
async function initSystemConfig() {
    console.log('🚀 开始初始化系统配置...\n');

    const app = await NestFactory.createApplicationContext(AppModule);
    const configService = app.get(SystemConfigService);

    try {
        // 获取当前配置
        const currentConfig = await configService.getConfig();
        console.log('📋 当前配置:');
        console.log(JSON.stringify(currentConfig, null, 2));
        console.log('\n');

        // 如果配置已存在，询问是否覆盖
        if (currentConfig.banners && currentConfig.banners.length > 0) {
            console.log('⚠️  系统配置已存在，如需更新请使用 API 接口');
            await app.close();
            return;
        }

        // 初始化默认配置
        const defaultConfig = {
            bookingEnabled: true,
            banners: [
                {
                    title: '欢迎使用预约系统',
                    imageUrl: 'https://via.placeholder.com/800x400/4CAF50/ffffff?text=Welcome',
                    sortOrder: 0,
                },
                {
                    title: '在线预约更便捷',
                    imageUrl: 'https://via.placeholder.com/800x400/2196F3/ffffff?text=Easy+Booking',
                    sortOrder: 1,
                },
            ],
            timeSlotLimit: {
                morningMaxPeople: 100,
                afternoonMaxPeople: 100,
            },
        };

        console.log('📝 初始化配置:');
        console.log(JSON.stringify(defaultConfig, null, 2));
        console.log('\n');

        // 更新配置
        const updatedConfig = await configService.updateConfig(defaultConfig);
        console.log('✅ 系统配置初始化成功！\n');
        console.log('📋 最新配置:');
        console.log(JSON.stringify(updatedConfig, null, 2));
    } catch (error) {
        console.error('❌ 初始化失败:', error);
    } finally {
        await app.close();
    }
}

// 运行脚本
initSystemConfig();
