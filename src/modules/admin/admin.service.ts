import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AdminRepository } from '../../repositories/admin.repository';
import { BookingService } from '../booking/booking.service';
import { LoginDto } from './dto/login.dto';
import { BookingStatus } from '../../entities/booking.entity';

const STATUS_LABEL: Record<string, string> = {
    pending:   '待支付',
    confirmed: '待使用',
    completed: '已完成',
    cancelled: '已取消',
    refunded:  '已退款',
};

const TRAVEL_MODE_LABEL: Record<string, string> = {
    scenicBus:   '景区摆渡车',
    selfDriving: '自驾出行',
    tourGroup:   '观光团',
};

const VEHICLE_TYPE_LABEL: Record<string, string> = {
    smallCar:        '小型客车',
    wheelMotorcycle: '摩托',
    nonMotorized:    '非机动车',
};

const TIME_SLOT_LABEL: Record<string, string> = {
    morning:   '上午',
    afternoon: '下午',
};

@Injectable()
export class AdminService {
    constructor(
        private readonly adminRepository: AdminRepository,
        private readonly bookingService: BookingService,
    ) {}

    async login(loginDto: LoginDto) {
        const admin = await this.adminRepository.findByUsername(loginDto.username);

        if (!admin) {
            throw new UnauthorizedException('用户名或密码错误');
        }

        const isPasswordValid = await this.adminRepository.comparePassword(loginDto.password, admin.password);

        if (!isPasswordValid) {
            throw new UnauthorizedException('用户名或密码错误');
        }

        await this.adminRepository.updateLastLogin(loginDto.username);

        return {
            username: admin.username,
            name: admin.name,
            apiKey: process.env.ADMIN_API_KEY,
        };
    }

    /**
     * 导出订单为 Excel，返回 Buffer，在内存中完成，无需临时文件
     */
    async exportBookingsToBuffer(query: {
        bookingDate?: string;
        status?: BookingStatus[];
        keyword?: string;
    }) {
        const bookings = await this.bookingService.getAllBookingsForExport(query);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('订单列表');

        sheet.columns = [
            { header: '订单号',     key: 'bookingId',    width: 20 },
            { header: '预约日期',   key: 'bookingDate',  width: 14 },
            { header: '时间段',     key: 'timeSlot',     width: 10 },
            { header: '状态',       key: 'status',       width: 10 },
            { header: '人数',       key: 'personCount',  width: 8  },
            { header: '联系人',     key: 'name',         width: 12 },
            { header: '手机号',     key: 'phone',        width: 14 },
            { header: '身份证号',   key: 'idCard',       width: 22 },
            { header: '出行方式',   key: 'travelMode',   width: 12 },
            { header: '车辆类型',   key: 'vehicleType',  width: 10 },
            { header: '车牌号',     key: 'licensePlate', width: 14 },
            { header: '出行人员',   key: 'passengers',   width: 40 },
            { header: '支付金额(元)', key: 'amount',     width: 14 },
            { header: '商户订单号', key: 'outTradeNo',   width: 32 },
            { header: '微信交易号', key: 'transactionId',width: 32 },
            { header: '支付时间',   key: 'paidAt',       width: 20 },
            { header: '创建时间',   key: 'createdAt',    width: 20 },
        ];

        // 表头加粗 + 背景色
        sheet.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        sheet.getRow(1).height = 28;

        for (const b of bookings) {
            // 将 passengers JSON 展开为易读文本
            let passengersText = '';
            if (b.passengers) {
                try {
                    const list: Array<{ name: string; phone: string; idCard: string }> =
                        typeof b.passengers === 'string' ? JSON.parse(b.passengers) : b.passengers;
                    passengersText = list
                        .map((p, i) => `${i + 1}.${p.name} ${p.phone} ${p.idCard}`)
                        .join('；');
                } catch { /* 解析失败保持空 */ }
            }

            const formatDate = (v: any) => {
                if (!v) return '';
                const d = new Date(v);
                return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
            };

            sheet.addRow({
                bookingId:    b.bookingId,
                bookingDate:  b.bookingDate ? String(b.bookingDate).substring(0, 10) : '',
                timeSlot:     TIME_SLOT_LABEL[b.timeSlot] ?? b.timeSlot,
                status:       STATUS_LABEL[b.status] ?? b.status,
                personCount:  b.personCount,
                name:         b.name ?? '',
                phone:        b.phone ?? '',
                idCard:       b.idCard ?? '',
                travelMode:   TRAVEL_MODE_LABEL[b.travelMode] ?? b.travelMode,
                vehicleType:  b.vehicleType ? (VEHICLE_TYPE_LABEL[b.vehicleType] ?? b.vehicleType) : '',
                licensePlate: b.licensePlate ?? '',
                passengers:   passengersText,
                amount:       b.amount != null ? (b.amount / 100).toFixed(2) : '',
                outTradeNo:   b.outTradeNo ?? '',
                transactionId: b.transactionId ?? '',
                paidAt:       formatDate(b.paidAt),
                createdAt:    formatDate(b.createdAt),
            });
        }

        // 数据行交替底色
        for (let i = 2; i <= sheet.rowCount; i++) {
            if (i % 2 === 0) {
                sheet.getRow(i).eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6FF' } };
                });
            }
        }

        const arrayBuffer = await workbook.xlsx.writeBuffer();
        return Buffer.from(arrayBuffer);
    }
}
