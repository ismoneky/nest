import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MESSAGE_QUIET_WINDOW_MAX_MS, MESSAGE_QUIET_WINDOW_MS } from '../../message/message-policy';

/**
 * 上界由策略常量推导，不写死：两处各写一个 1440 迟早在调整策略时漂移
 */
const MAX_QUIET_WINDOW_MINUTES = MESSAGE_QUIET_WINDOW_MAX_MS / 60000;
const DEFAULT_QUIET_WINDOW_MINUTES = MESSAGE_QUIET_WINDOW_MS / 60000;

/**
 * 手动触发扫描任务的可选参数（`POST /admin/tasks/*`）
 *
 * **只影响这一次调用**：cron 路径不经过这个 DTO，静默期永远是 A 规则的默认值。
 * 换句话说这里能改的只是「这一次扫描看不看刚下的单」，不是把规则改松。
 */
export class TriggerTaskDto {
    /**
     * 覆盖本次扫描的静默期（分钟）。不传 = 默认 2 小时。
     *
     * `0` 是**合法值**，表示不设静默期。测「下单 → 过期 → 收通知」这条链路时必须用它：
     * 否则刚下的单要干等 2 小时才会被扫到，一遍都验不完。
     *
     * ⚠️ 生产环境慎用：刚下完单的用户会立刻收到「订单已过期」/「请尽快核销」，
     * 而 A 规则存在的意义正是挡掉这种打扰（§4.2.5）。
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: '静默期必须是整数分钟' })
    @Min(0, { message: '静默期不能为负' })
    @Max(MAX_QUIET_WINDOW_MINUTES, {
        message: `静默期最长 ${MAX_QUIET_WINDOW_MINUTES} 分钟（默认 ${DEFAULT_QUIET_WINDOW_MINUTES}）`,
    })
    quietWindowMinutes?: number;

    /**
     * 过期边界是否**含当天**（`bookingDate <= 今天`）。
     *
     * **不传 = true**。「不传」与「传 true」等价，只有显式传 `false` 才能退回
     * 「严格早于今天」——这个接口的定位是管理员清干净当前状态，
     * 判据本就是「此刻之前」；把默认值设成 false 会让默认行为与接口语义不符。
     *
     * ⚠️ 含当天意味着**当天未核销的订单会当场作废**（核销接口对它们返回
     * 「当前状态：expired」），且当天名额随之释放（统计只认 pending/confirmed）。
     * 要「封盘当天」请用预约开关，不要用这个接口。
     *
     * ⚠️ 只对 `expire-scan` 有意义；`daily-reminder` 忽略它（那个任务不做过期流转）。
     */
    @IsOptional()
    @IsBoolean()
    includeToday?: boolean;
}
