# 服务号推送首版运行说明

本版实现六类订单/退款系统通知：登录保存 UnionID，定时同步关注者，站内信与服务号发送快照一起落库，后台调用模板消息接口。所有示例凭据、模板 ID、关键词均为占位；默认没有真实微信请求。真实账号权限、UnionID 返回条件、字段规则与调用配额仍需上线前联调。

## 配置与启用顺序

| 环境变量 | 默认值/说明 |
| --- | --- |
| `OA_SYNC_ENABLED` | `false`；只控制粉丝同步 |
| `OA_ENABLED` | `false`；控制新消息进入发送队列及后台投递 |
| `OA_WORKER_ENABLED` | `true`；同一数据库只允许一个实例为 true，其他实例可照常写入新消息 |
| `OA_APPID`、`OA_SECRET` | 服务号凭据；缺失、非法 AppID、占位字符串均不能发请求 |
| `WX_APPID` | 保留已有小程序 AppID；服务号消息卡片跳该小程序的首页 |
| `OA_TEMPLATES_FILE` | JSON 配置路径；相对进程工作目录，推荐生产使用绝对路径 |

配置读取于进程启动，变更后需要重启。`OA_ENABLED` 是发送总开关，`OA_SYNC_ENABLED` 可以单独打开，使“先同步身份、再开启推送”成为可验证的两步。关闭任意开关不会自动删除消息或重放历史。

1. 备份生产 SQLite 并停止服务，执行一次 [增量 SQL](/Users/lufy/Desktop/ff/nest/docs/deploy-2026-09-21-wechat-oa.sql)。生产保持 `synchronize=false`。SQL 在单事务内执行，CLI 必须用 `-bail`；重复执行会因已有列报错，不要重复套用。
2. 部署构建产物，按 `.env.example` 增加配置，两项功能开关先为 false。模板文件不在 TypeScript 构建产物里，需单独复制到服务器；现有 `upload.sh` 不会自动复制该文件。
3. 把 [模板示例](/Users/lufy/Desktop/ff/nest/config/wechat-oa-templates.example.json)复制为实际配置，替换模板 ID、所有 `REPLACE_*` 关键词名和长度。用服务号后台实际模板的关键词、类型和规则校对，不可将示例当真实模板格式。
4. 核对服务号/小程序开放平台绑定、公众号关联小程序、IP 白名单、账号权限与 token 是否被其他系统共用。当前 token provider 使用普通 `cgi-bin/token`，没有接入第三方 token 服务。
5. 设 `OA_SYNC_ENABLED=true`，仍保持 `OA_ENABLED=false`，重启。管理员手动同步一次，查看状态；测试用户重新访问首页完成登录后，验证小程序用户与粉丝的 UnionID 匹配。
6. 配好真实模板后，仅在测试环境开启 `OA_ENABLED=true`，使用测试微信账号验证通知。确认消息确实可接收、可打开已发布首页后，再部署生产开启。

所有实例用于写入的 OA 模板和账号配置必须相同。多实例时只启用一个 OA worker；本实现不提供跨实例分布式租约。用户尚未重新登录补齐 UnionID 时只能等待/跳过 OA，原登录、站内信与订单功能照常工作。

## 模板映射

模板文件结构如下，关键词名和长度仅展示配置方式：

```json
{
  "version": 1,
  "templates": {
    "REFUND_SUCCESS": {
      "templateId": "REPLACE_WITH_TEMPLATE_ID",
      "fields": {
        "REPLACE_WITH_AMOUNT_KEY": { "source": "refundAmount", "maxLength": 20 },
        "REPLACE_WITH_APPLY_KEY": { "source": "bizNo", "maxLength": 32 }
      }
    }
  }
}
```

支持的数据来源：`bookingId` 订单号，`bizNo` 退款申请单号，`refundAmount` 元（两位小数），`rejectReason` 驳回理由，`applyDeadline` 申请截止日，`eventTime` 北京时间 `YYYY-MM-DD HH:mm:ss`，`status` 对应事件的固定中文描述。

真实模板的字段必须选择该事件实际提供的数据源。数据缺失或超过配置长度时，OA 记 `TEMPLATE_DATA_INVALID` 并保留完整站内信；不会静默截断订单号/退款原因。没有模板或模板仍为占位时记录 `TEMPLATE_UNCONFIGURED`。不配置某类模板即可仅保留该类站内信。开启发送后，启动日志通过 `OA_TEMPLATES_UNCONFIGURED` 列出未就绪的消息类型，状态接口的 `templateReadiness` 逐项返回是否通过本地配置校验（不代表微信已认可该模板）。

六类事件为 `ORDER_EXPIRE_REMINDER`、`ORDER_EXPIRED`、`REFUND_ACCEPTED`、`REFUND_APPROVED`、`REFUND_REJECTED`、`REFUND_SUCCESS`。模板 API 的实际类型约束仍需微信后台核对，本实现先提供字段名/来源/长度适配层。

## 调度和手动核对

- 粉丝同步：上海时区 `0 43 */2 * * *`，00:43、02:43、04:43……。
- 发送任务：每分钟第 17 秒，每轮最多取 20 条、HTTP 并发 2，运行 60 秒后停止领取新消息。
- 粉丝同步最多运行 5 分钟/1000 页；中途失败或粉丝总数发生变化，保留本轮未出现用户的历史关注状态，下轮重新全量扫描。大粉丝量须结合额度和运行时长调整预算。
- 缺 UnionID 或信息查询失败按 2、4、8、16、24 小时退避补信息；已保存 UnionID 的粉丝无需每次重复查信息。
- 同步批次与待发送内容落在主数据库；新写入走现有 SQLite 串行事务机制，网络调用在事务外。

管理员接口沿用 `x-admin-token`，也兼容项目已有的 `x-admin-key`。以下路径未含反向代理的 `/api` 前缀：

| 方法/路径 | 行为 |
| --- | --- |
| `POST /admin/wechat-oa/sync` | 手动跑一次粉丝同步，仍受同步开关和 worker 开关约束；返回 `COMPLETED / FAILED / DISABLED / CONFIG_INVALID / RUNNING` |
| `GET /admin/wechat-oa/status` | 返回开关、凭据是否齐备、逐模板配置状态 `templateReadiness`、最新批次、最后成功同步时间、关注人数、缺 UnionID 人数和 `syncStale` |

手动同步是同步 HTTP 操作，大批量请求超时后应先查状态，不能据客户端超时判断扫描已经结束。进程内重入锁会阻止重复扫描。状态接口不返回凭据、粉丝 OpenID 或游标。`syncStale=true` 表示从未成功，或距上次完整同步超过 4 小时；结合批次失败日志排查。

## 消息状态与异常恢复

| 值 | 状态 | 运维含义 |
| --- | --- | --- |
| 0 | PENDING | 等待发送/身份或明确可重试错误 |
| 1 | SENT | 微信 API 已受理，有 `oaMsgId`；不是送达/已读证明 |
| 2 | FAILED | 永久错误，或达到三次发送上限 |
| 3 | SKIPPED | 关闭、占位/缺模板、缺字段、取关、过期等，查看 `oaSkipReason` |
| 4 | SENDING | 已领取，正在处理 |
| 5 | UNKNOWN | HTTP 结果不确定或领取后进程中断；默认不自动重发 |

身份暂缺时 10 分钟后再查，不增加发送次数；明确未关注时结束当前投递，后续重新关注不重放旧消息。普通明确临时错误按 1、5 分钟重试；超额错误候选按 1 小时再试；实际发送总共最多三次，token 失效当轮最多刷新一次。获得 token 失败不算发送，但仍受消息有效期限制。

提醒类有效期为当天结束，已过期可退款通知为申请截止日结束（无截止日时 24 小时），退款事件 24 小时。实际产生消息时即写入有效期和完整模板快照，之后不从站内信正文反向解析。

超过 2 分钟的 `SENDING` 转 `UNKNOWN`。发送成功后写库失败只尝试本地写回，不再次请求微信；无法恢复的记录保留待排查。不要直接批量把 UNKNOWN/历史 SKIPPED 改回 PENDING，远端可能已经受理或通知已经失效。

日常可用只读 SQL 检查队列分布：

```sql
SELECT oaSendStatus, oaSkipReason, oaLastError, count(*) AS count
FROM messages
GROUP BY oaSendStatus, oaSkipReason, oaLastError;
SELECT status, startedAt, completedAt, seenCount, infoFailureCount, lastError
FROM wx_oa_sync_runs ORDER BY startedAt DESC LIMIT 12;
```

不开服务号回调；原微信支付和退款回调照常运行。管理员自由文本通知仍走原站内信入口，不会被本版 worker 当作模板消息发送。

## 本地验证

```bash
npm test
npm run build
```

测试使用内存 SQLite、模拟微信 HTTP 和虚构账号，不使用真实 AppSecret。生产 SQL 在内存旧表上验证升级，原数据与状态保持不变。当前测试不能替代真实微信账号联调；后台显示“接口受理”也不能替代最终送达回执。
