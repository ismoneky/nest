import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Booking, BookingDocument } from '../entities/booking.entity';
import { CreateBookingDto } from '../modules/booking/dto/createBooking.dto';
import { GetBookingsDto } from '../modules/booking/dto/getBookings.dto';
import { UpdateBookingDto } from '../modules/booking/dto/updateBooking.dto';
import { v4 as uuidv4 } from 'uuid';

/**
 * 预约订单数据访问层
 * 负责与 MongoDB 数据库交互
 */
export class BookingRepository {
    constructor(@InjectModel(Booking.name) private readonly bookingModel: Model<BookingDocument>) {}

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据传输对象
     * @returns 创建的订单文档
     */
    async createBooking(createBookingDto: CreateBookingDto) {
        try {
            // 生成唯一的订单ID
            const booking = new this.bookingModel({
                bookingId: uuidv4(),
                ...createBookingDto,
                bookingDate: new Date(createBookingDto.bookingDate),
            });
            const savedBooking = await booking.save();
            // 返回纯对象,避免 Mongoose Document 内存泄漏
            return savedBooking.toObject();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create booking');
        }
    }

    /**
     * 更新预约订单
     * @param bookingId 订单ID
     * @param updateBookingDto 更新数据传输对象
     * @returns 更新后的订单文档
     */
    async updateBooking(bookingId: string, updateBookingDto: UpdateBookingDto) {
        try {
            const updateData: any = { ...updateBookingDto };
            // 如果更新日期,需要转换为 Date 对象
            if (updateBookingDto.bookingDate) {
                updateData.bookingDate = new Date(updateBookingDto.bookingDate);
            }

            // findOneAndUpdate 返回更新后的文档 (new: true), 使用 lean() 返回纯对象
            const booking = await this.bookingModel.findOneAndUpdate({ bookingId }, updateData, { new: true }).lean().exec();

            if (!booking) {
                throw new NotFoundException(`Booking with ID ${bookingId} not found`);
            }

            return booking;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update booking');
        }
    }

    /**
     * 删除预约订单
     * @param bookingId 订单ID
     * @returns 被删除的订单文档
     */
    async deleteBooking(bookingId: string) {
        try {
            const result = await this.bookingModel.findOneAndDelete({ bookingId }).lean().exec();

            if (!result) {
                throw new NotFoundException(`Booking with ID ${bookingId} not found`);
            }

            return result;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to delete booking');
        }
    }

    /**
     * 根据订单ID查询单个订单
     * @param bookingId 订单ID
     * @returns 订单文档
     */
    async getBookingById(bookingId: string) {
        try {
            const booking = await this.bookingModel.findOne({ bookingId }).lean().exec();

            if (!booking) {
                throw new NotFoundException(`Booking with ID ${bookingId} not found`);
            }

            return booking;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking');
        }
    }

    /**
     * 根据条件查询订单列表 (分页)
     * 支持按 wechatOpenId, bookingDate, timeSlot, status 筛选
     * @param query 查询条件 (包含分页参数)
     * @returns 订单文档数组和总数
     */
    async getBookings(query: GetBookingsDto) {
        try {
            const filter: any = {};

            // 按微信OpenID筛选 (利用索引)
            if (query.wechatOpenId) {
                filter.wechatOpenId = query.wechatOpenId;
            }

            // 按预约日期筛选 (利用索引)
            // 查询指定日期的所有订单 (00:00:00 - 23:59:59)
            if (query.bookingDate) {
                const date = new Date(query.bookingDate);
                const nextDay = new Date(date);
                nextDay.setDate(date.getDate() + 1);
                filter.bookingDate = {
                    $gte: date,
                    $lt: nextDay,
                };
            }

            // 按时间段筛选
            if (query.timeSlot) {
                filter.timeSlot = query.timeSlot;
            }

            // 按订单状态筛选 (利用索引)
            if (query.status) {
                filter.status = query.status;
            }

            // 分页参数
            const page = query.page || 1;
            const pageSize = query.pageSize || 10;
            const skip = (page - 1) * pageSize;

            // 并行执行查询和计数
            // 使用 .lean() 返回纯 JavaScript 对象,减少内存占用
            const [bookings, total] = await Promise.all([
                this.bookingModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean().exec(),
                this.bookingModel.countDocuments(filter).exec(),
            ]);

            return {
                bookings,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize),
            };
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get bookings');
        }
    }

    /**
     * 统计指定日期的预约人数 (按时间段分组)
     * @param bookingDate 预约日期 (YYYY-MM-DD)
     * @returns 各时间段的预约人数统计
     */
    async getBookingStatsByDate(bookingDate: string) {
        try {
            const date = new Date(bookingDate);
            const nextDay = new Date(date);
            nextDay.setDate(date.getDate() + 1);

            // 使用聚合管道统计各时间段的预约人数
            const stats = await this.bookingModel
                .aggregate([
                    {
                        // 筛选指定日期的订单
                        $match: {
                            bookingDate: {
                                $gte: date,
                                $lt: nextDay,
                            },
                            // 只统计未取消的订单
                            status: { $ne: 'cancelled' },
                        },
                    },
                    {
                        // 按时间段分组,统计人数
                        $group: {
                            _id: '$timeSlot',
                            totalPeople: { $sum: '$numberOfPeople' },
                            bookingCount: { $sum: 1 },
                        },
                    },
                ])
                .exec();

            // 格式化返回结果
            const result = {
                date: bookingDate,
                morning: {
                    totalPeople: 0,
                    bookingCount: 0,
                },
                afternoon: {
                    totalPeople: 0,
                    bookingCount: 0,
                },
            };

            stats.forEach((stat) => {
                if (stat._id === 'morning') {
                    result.morning.totalPeople = stat.totalPeople;
                    result.morning.bookingCount = stat.bookingCount;
                } else if (stat._id === 'afternoon') {
                    result.afternoon.totalPeople = stat.totalPeople;
                    result.afternoon.bookingCount = stat.bookingCount;
                }
            });

            return result;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking stats');
        }
    }
}
