import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as ExcelJS from 'exceljs';
import { AdminRepository } from '../../repositories/admin.repository';
import { BookingService } from '../booking/booking.service';
import { LoginDto } from './dto/login.dto';
import { BookingStatus } from '../../entities/booking.entity';
import { RefundApplyService } from '../refund/refund-apply.service';
import { RefundApplyQuery } from '../../repositories/refund-apply.repository';
import { LoggingService } from '../logging/logging.service';
import { MessageService } from '../message/message.service';
import { SendMessageDto } from './dto/send-message.dto';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';

/**
 * 管理端操作人身份（来自 `x-admin-token`，§4.3.4）
 *
 * 两个字段都可为 null：`AdminAuthGuard` 在只有 `x-admin-key`（无 token）时
 * 放行并置 `req.admin = null`。此时审核照样能完成，只是 `refund_applies`
 * 里记不下「谁点的」——调用方必须把这种情况当**正常路径**处理，
 * 而不是当成错误拒绝操作。
 */
export interface AdminOperator {
    adminId: number | null;
    adminName: string | null;
}

/**
 * 管理端 token 有效期（12h，§4.3.4）
 *
 * 比用户 token（30 天）短得多：管理端 token 是**操作人身份凭据**，
 * 会被写进 `refund_applies.auditAdminId` 与审计日志；有效期越长，
 * 「这个驳回是谁点的」这个结论就越可能对应到一个早已离职的会话。
 */
const ADMIN_TOKEN_EXPIRES_IN = '12h';

/**
 * 订单状态中文映射（用于 Excel 导出）。
 *
 * ⚠️ 跨仓镜像：唯一权威表在 admin 仓库 `src/constants/booking.ts` 的 BOOKING_STATUS_MAP。
 * 两个仓库无法共享模块，新增状态（如 expired）时必须同时改这两处。
 * 保持 `Record<string, string>` 并在使用处 `?? b.status` 兜底，
 * 这样后端先上线新状态时导出只会退化成英文 key，不会崩。
 */
const STATUS_LABEL: Record<string, string> = {
    pending:   '待支付',
    confirmed: '待使用',
    completed: '已完成',
    cancelled: '已取消',
    refunded:  '已退款',
    expired:   '已过期',
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
        private readonly jwtService: JwtService,
        private readonly refundApplyService: RefundApplyService,
        private readonly loggingService: LoggingService,
        private readonly messageService: MessageService,
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

        // adminToken 只用于**识别操作人**，不取代 apiKey：apiKey 仍是管理端接口的
        // 准入凭据，无 token 时接口照常可用（auditAdminId 记 null）。
        // 两者并存是 §4.3.4「最小改动、向后兼容」的全部含义。
        const adminToken = this.jwtService.sign(
            { adminId: admin.id, username: admin.username, name: admin.name, type: 'admin' },
            {
                secret: process.env.JWT_SECRET || 'default_jwt_secret_change_in_production',
                expiresIn: ADMIN_TOKEN_EXPIRES_IN,
            },
        );

        return {
            username: admin.username,
            name: admin.name,
            apiKey: process.env.ADMIN_API_KEY,
            adminToken,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 退款审核（阶段 3，§4.3.3）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 退款申请列表（分页 + 筛选；pending 超 48h 已由服务层标 isTimeout）
     */
    async getRefundApplies(query: RefundApplyQuery) {
        return await this.refundApplyService.getAuditList(query);
    }

    /**
     * 退款申请详情：申请单 + 订单快照 + 该订单全部历史申请
     *
     * 订单读取走 `getBookingByIdForAdmin`（无归属校验）——审核员看的是别人的订单。
     */
    async getRefundApplyDetail(applyNo: string) {
        return await this.refundApplyService.getAuditDetail(applyNo, (bookingId) =>
            this.bookingService.getBookingByIdForAdmin(bookingId),
        );
    }

    /**
     * 退款审核「通过」：单据置 approved → 调既有退款链路真正退钱
     *
     * ── 为什么是这个顺序（§4.3.3.1 的实现顺序，不能颠倒）─────────────────────
     * 先落 `approved`、再调微信：
     *   - 若先调微信成功、落库失败 → 申请单停在 pending 且钱已退，
     *     管理员看到「还没审」会再点一次通过 → **重复退款**；
     *   - 现在的最坏情况是 approved + 微信没调起来，订单停在 `refunding`，
     *     由既有的 15 分钟退款对账 Cron 收敛。这与用户自助退款走的是同一套容错，
     *     **不需要任何新代码**——这正是「复用现有退款链路」的全部价值。
     *
     * 因此：`initiateRefund` 抛错时**不回滚 approved**，只记日志并把错误抛给调用方。
     * 回滚才是更危险的选项（它会把上面那个重复退款的窗口重新打开）。
     *
     * ── 为什么 openid 传空串 ────────────────────────────────────────────────
     * `initiateRefund` 第二步是归属校验 `booking.wechatOpenId !== openid`。
     * 审核路径下操作者是管理员、不是下单人，用真实 openid 传空必然失败。
     * 该分支由 `options.asAdmin` 显式跳过（阶段 2A 已就位），空串只是占位。
     */
    async approveRefundApply(applyNo: string, operator: AdminOperator, remark?: string) {
        const { apply, outRefundNo } = await this.refundApplyService.prepareApproval(applyNo, operator, remark);

        try {
            const refundResult = await this.bookingService.initiateRefund(
                apply.bookingId,
                '',
                { asAdmin: true, outRefundNo },
            );
            await this.writeAuditLog(apply.applyNo, apply.bookingId, 'approve', operator, {
                outRefundNo,
                refundAmount: apply.refundAmount,
            });
            return { apply, outRefundNo, refundResult };
        } catch (error) {
            // 不回滚单据状态：见上方顺序说明。日志是这里唯一的追责线索，
            // 记下 outRefundNo 才能与微信账单对上。
            await this.writeAuditLog(
                apply.applyNo,
                apply.bookingId,
                'approve-refund-failed',
                operator,
                { outRefundNo, error: (error as Error).message },
                AppLogLevel.ERROR,
            );
            throw error;
        }
    }

    /**
     * 退款审核「拒绝」：单据置 rejected + 必填拒绝理由
     *
     * **不改订单状态**：订单全程保持 `expired`，用户看到的「已驳回」由
     * `refund_applies.status` 组合出来（§4.3.5）。这样数据库里只写一次，
     * 中途失败不会留下 v1 那种「两次写死单」的竞态。
     */
    async rejectRefundApply(applyNo: string, operator: AdminOperator, rejectReason: string, remark?: string) {
        const apply = await this.refundApplyService.rejectApply(applyNo, operator, rejectReason, remark);
        await this.writeAuditLog(apply.applyNo, apply.bookingId, 'reject', operator, { rejectReason });
        return apply;
    }

    /**
     * 管理员手动发消息（§6 `/admin/messages/send`）
     *
     * ── 为什么**不**校验 openid 是否存在 ────────────────────────────────────
     * 服务端只能拿 `user_profiles.wechatOpenId` 反查，而那是「填过资料的用户」，
     * 不等于「登录过小程序的用户」——很多用户只下单不填资料。
     * 校验会把这些人挡在外面，而放行的代价很小：消息只是躺在
     * `messages` 表里，用户下次进消息中心就能看到，**不存在的 openid 不会报错**。
     *
     * ── 手动消息不受每日配额限制 ────────────────────────────────────────────
     * `ADMIN_NOTICE` 不计入 `MESSAGE_DAILY_LIMIT`（见 `MessageService.send` 的说明）：
     * 管理员想向某个用户解释一件事，却被系统配额挡住，是最不该出现的情形。
     *
     * ── 审计 ────────────────────────────────────────────────────────────────
     * `senderType='ADMIN'` + `adminId` 落在消息行上（用户端显示为「管理员」），
     * 同时写一条 `admin-action` 日志——消息表回答「用户收到了什么」，
     * 日志回答「谁在什么时候发的」，两者的保留期不同（消息 90 天会被 T3 删除），
     * 所以不能只留一处。
     */
    async sendMessage(dto: SendMessageDto, operator: AdminOperator) {
        const message = await this.messageService.sendAdminNotice({
            openid: dto.openid,
            title: dto.title,
            content: dto.content,
            adminId: operator.adminId,
        });

        this.loggingService.write({
            source: AppLogSource.BACKEND,
            level: AppLogLevel.INFO,
            category: AppLogCategory.RUNTIME,
            message: `管理员发送站内信: ${dto.title}`,
            context: {
                action: 'send-message',
                adminId: operator.adminId,
                adminName: operator.adminName,
                openid: dto.openid,
                messageId: message?.id ?? null,
                // 预留字段当前不产生投递，记下来是为了将来有人问「为什么没收到推送」时能对上
                sendOaRequested: dto.sendOa === true,
            },
        });

        return {
            messageId: message?.id ?? null,
            createdAt: message ? new Date(message.createdAt).getTime() : null,
            /**
             * 服务号是否真的投递了。恒为 false——本期 `OA_ENABLED=false`，
             * `sendOa` 只在库里留下痕迹。**由后端下发而不是让前端硬编码这个提示**：
             * 服务号分支上线后，这里会变成真实结果，前端不用改。
             */
            oaSent: false,
        };
    }

    /**
     * 审核操作日志（§4.3.3「操作日志」）
     *
     * 取不到操作人时按 `operatorUnknown: true` 标注而不是拒绝操作：
     * `x-admin-token` 是可选增强，仅有 `x-admin-key` 时审核必须照常可用。
     * 日志失败不影响审核结果。
     */
    private async writeAuditLog(
        applyNo: string,
        bookingId: string,
        action: string,
        operator: AdminOperator,
        extra: Record<string, unknown>,
        level: AppLogLevel = AppLogLevel.INFO,
    ): Promise<void> {
        try {
            await this.loggingService.write({
                source: AppLogSource.BACKEND,
                level,
                category: AppLogCategory.PAYMENT,
                message: `退款审核操作: ${action}`,
                route: '/admin/refund-applies',
                context: {
                    refundApplyId: applyNo,
                    bookingId,
                    action,
                    operator: operator.adminName ?? null,
                    operatorId: operator.adminId ?? null,
                    operatorUnknown: operator.adminId === null,
                    ...extra,
                },
            });
        } catch {
            // 日志失败只影响可追溯性，不影响审核结果
        }
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
