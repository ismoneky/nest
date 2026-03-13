import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MongoClient } from 'mongodb';
import { DataSource } from 'typeorm';
import { User } from '../src/entities/user.entity';
import { Admin } from '../src/entities/admin.entity';
import { Booking } from '../src/entities/booking.entity';
import { Announcement } from '../src/entities/announcement.entity';
import { SystemConfig } from '../src/entities/system-config.entity';

/**
 * MongoDB 到 SQLite 数据迁移脚本
 *
 * 使用方法:
 * 1. 确保 MongoDB 正在运行
 * 2. 在 .env 中配置 MONGO_* 变量
 * 3. 运行: npm run migrate
 */
async function migrateData() {
    console.log('🚀 开始从 MongoDB 迁移数据到 SQLite...\n');

    // MongoDB 连接配置
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/booking_dev';
    let mongoClient: MongoClient;
    let app: any;

    try {
        // 连接 MongoDB
        console.log('📡 连接 MongoDB:', mongoUri);
        mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        const db = mongoClient.db();
        console.log('✅ MongoDB 连接成功\n');

        // 启动 NestJS 应用 (连接 SQLite)
        console.log('📡 连接 SQLite...');
        app = await NestFactory.createApplicationContext(AppModule);
        const dataSource = app.get(DataSource);
        console.log('✅ SQLite 连接成功\n');

        // 清空 SQLite 数据 (可选)
        console.log('⚠️  清空 SQLite 现有数据...');
        await dataSource.synchronize(true); // 强制重建表
        console.log('✅ SQLite 数据已清空\n');

        // 迁移 Users
        console.log('📦 迁移用户数据...');
        const mongoUsers = await db.collection('users').find().toArray();
        const userRepo = dataSource.getRepository(User);
        for (const mongoUser of mongoUsers) {
            const user = userRepo.create({
                userId: mongoUser.userId,
                wechatOpenId: mongoUser.wechatOpenId,
                wechatNickname: mongoUser.wechatNickname,
                wechatAvatarUrl: mongoUser.wechatAvatarUrl,
                createdAt: mongoUser.createdAt,
                updatedAt: mongoUser.updatedAt,
            });
            await userRepo.save(user);
        }
        console.log(`✅ 迁移了 ${mongoUsers.length} 个用户\n`);

        // 迁移 Admins
        console.log('📦 迁移管理员数据...');
        const mongoAdmins = await db.collection('admins').find().toArray();
        const adminRepo = dataSource.getRepository(Admin);
        for (const mongoAdmin of mongoAdmins) {
            const admin = adminRepo.create({
                username: mongoAdmin.username,
                password: mongoAdmin.password,
                name: mongoAdmin.name,
                lastLoginAt: mongoAdmin.lastLoginAt,
                createdAt: mongoAdmin.createdAt,
                updatedAt: mongoAdmin.updatedAt,
            });
            await adminRepo.save(admin);
        }
        console.log(`✅ 迁移了 ${mongoAdmins.length} 个管理员\n`);

        // 迁移 Bookings
        console.log('📦 迁移预约订单数据...');
        const mongoBookings = await db.collection('bookings').find().toArray();
        const bookingRepo = dataSource.getRepository(Booking);
        for (const mongoBooking of mongoBookings) {
            const booking = bookingRepo.create({
                bookingId: mongoBooking.bookingId,
                wechatOpenId: mongoBooking.wechatOpenId,
                name: mongoBooking.name,
                phone: mongoBooking.phone,
                idCard: mongoBooking.idCard,
                bookingDate: mongoBooking.bookingDate,
                timeSlot: mongoBooking.timeSlot,
                travelMode: mongoBooking.travelMode,
                licensePlate: mongoBooking.licensePlate,
                vehicleType: mongoBooking.vehicleType,
                tourGroupName: mongoBooking.tourGroupName,
                tourOrderNumber: mongoBooking.tourOrderNumber,
                personCount: mongoBooking.personCount,
                remarks: mongoBooking.remarks,
                status: mongoBooking.status,
                createdAt: mongoBooking.createdAt,
                updatedAt: mongoBooking.updatedAt,
            });
            await bookingRepo.save(booking);
        }
        console.log(`✅ 迁移了 ${mongoBookings.length} 个预约订单\n`);

        // 迁移 Announcements
        console.log('📦 迁移公告数据...');
        const mongoAnnouncements = await db.collection('announcements').find().toArray();
        const announcementRepo = dataSource.getRepository(Announcement);
        for (const mongoAnnouncement of mongoAnnouncements) {
            const announcement = announcementRepo.create({
                announcementId: mongoAnnouncement.announcementId,
                title: mongoAnnouncement.title,
                content: mongoAnnouncement.content,
                isActive: mongoAnnouncement.isActive,
                sortOrder: mongoAnnouncement.sortOrder,
                createdAt: mongoAnnouncement.createdAt,
                updatedAt: mongoAnnouncement.updatedAt,
            });
            await announcementRepo.save(announcement);
        }
        console.log(`✅ 迁移了 ${mongoAnnouncements.length} 个公告\n`);

        // 迁移 SystemConfig
        console.log('📦 迁移系统配置...');
        const mongoConfigs = await db.collection('systemconfigs').find().toArray();
        const configRepo = dataSource.getRepository(SystemConfig);
        for (const mongoConfig of mongoConfigs) {
            const config = configRepo.create({
                configId: mongoConfig.configId,
                bookingEnabled: mongoConfig.bookingEnabled,
                bannersJson: JSON.stringify(mongoConfig.banners || []),
                timeSlotLimitJson: JSON.stringify(mongoConfig.timeSlotLimit || {}),
                createdAt: mongoConfig.createdAt,
                updatedAt: mongoConfig.updatedAt,
            });
            await configRepo.save(config);
        }
        console.log(`✅ 迁移了 ${mongoConfigs.length} 个系统配置\n`);

        console.log('🎉 数据迁移完成！');
        console.log('\n📊 迁移统计:');
        console.log(`  - 用户: ${mongoUsers.length}`);
        console.log(`  - 管理员: ${mongoAdmins.length}`);
        console.log(`  - 预约订单: ${mongoBookings.length}`);
        console.log(`  - 公告: ${mongoAnnouncements.length}`);
        console.log(`  - 系统配置: ${mongoConfigs.length}`);

    } catch (error) {
        console.error('❌ 迁移失败:', error);
        process.exit(1);
    } finally {
        // 关闭连接
        if (mongoClient) {
            await mongoClient.close();
            console.log('\n✅ MongoDB 连接已关闭');
        }
        if (app) {
            await app.close();
            console.log('✅ SQLite 连接已关闭');
        }
    }
}

// 运行迁移
migrateData();
