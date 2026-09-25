/**
 * 今日名额概览（GET /bookings/today-quota 响应体）
 *
 * 【安全边界，改前必读】本结构本身就是防营收泄漏的边界，不是随手定义的数据形状。
 *
 * 背景：单价是公开的（提交订单页直接展示），所以
 *     营收 = 付费人数 × 单价 ；付费人数 = 已约人数 − 免费人数
 * 「已约人数」默认不出网。而「剩余名额」全天轮询的首尾差值就等于当天的
 * 已约人数，根本不需要知道总量。故本接口默认采取「充足时不下发任何数字」：
 * 观察者拿不到基线，减法失效。
 * 后台可显式将展示阈值调到 100%，此时代表运营选择全程公开精确余量 —— 该阈值下
 * 档位恒定落在 'ample'（不紧张）或 'limited'（紧张），两者都下发 remaining。
 *
 * 因此：
 *  - capacity 里【禁止新增】total / maxOrders / currentOrders / bookedPeople / bookingCount
 *    —— 「已约单量 = 总限额 − 剩余」，返回总限额等于把已约单量直接送出去
 *  - level='plenty' 与 'full' 时【禁止】带上 remaining —— 这是刻意不给，不是疏漏
 *  - freeQuota 不返回 used —— 它可由 limit − remaining 推出，返回没有收益
 *  - freeQuota.remaining 精确下发是安全的：免费人数必须与「已约人数」配对才能算出
 *    付费人数，而已约人数已不可得
 */
export interface TodayQuotaOverview {
    /** 服务端认定的「今天」（北京时间 YYYY-MM-DD），供前端跨天检测与「今天」判定 */
    date: string;
    capacity: {
        /**
         * 四档，含义与前端呈现一一对应（判定见 BookingService.buildCapacityLevel）：
         *  - 'plenty'  充裕到无需报数 —— 不下发 remaining，前端整行不渲染
         *  - 'ample'   宽裕，可报数   —— 前端中性色「今日剩余 N 个名额」
         *  - 'limited' 紧张           —— 前端红色「今日仅剩 N 个名额」
         *  - 'full'    已满           —— 前端红色「今日名额已满」
         * 'plenty' 必须保留：旧版小程序仍在线上跑，去掉会让它们的档位判断落空。
         */
        level: 'plenty' | 'ample' | 'limited' | 'full';
        /**
         * 仅 level='limited' / 'ample' 时存在；'plenty' 与 'full' 刻意不下发
         * @see 本文件顶部「安全边界」
         */
        remaining?: number;
    };
    freeQuota: {
        /** 免费活动是否开启；false 时前端整项不展示（活动对用户隐藏） */
        enabled: boolean;
        /** 免费名额上限（前端预约日期卡片本就在展示，非新增暴露） */
        limit: number;
        /** 今日剩余免费名额，>= 0，保留精确值 */
        remaining: number;
    };
}
