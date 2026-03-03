import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Admin, AdminDocument } from '../entities/admin.entity';
import * as bcrypt from 'bcrypt';

/**
 * 管理员数据访问层
 */
@Injectable()
export class AdminRepository {
    constructor(@InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>) {}

    /**
     * 根据用户名查找管理员
     * @param username 用户名
     * @returns 管理员文档
     */
    async findByUsername(username: string) {
        try {
            return await this.adminModel.findOne({ username }).lean().exec();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find admin');
        }
    }

    /**
     * 验证密码
     * @param plainPassword 明文密码
     * @param hashedPassword 加密密码
     * @returns 是否匹配
     */
    async comparePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
        try {
            return await bcrypt.compare(plainPassword, hashedPassword);
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to compare password');
        }
    }

    /**
     * 更新最后登录时间
     * @param username 用户名
     */
    async updateLastLogin(username: string) {
        try {
            await this.adminModel.updateOne({ username }, { lastLoginAt: new Date() }).exec();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update last login');
        }
    }

    /**
     * 创建管理员 (仅用于初始化)
     * @param username 用户名
     * @param password 密码
     * @param name 姓名
     */
    async createAdmin(username: string, password: string, name: string) {
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const admin = new this.adminModel({
                username,
                password: hashedPassword,
                name,
            });
            const savedAdmin = await admin.save();
            return savedAdmin.toObject();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create admin');
        }
    }
}
