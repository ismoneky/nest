# 微信服务号业务消息与 UnionID 同步研究

研究日期：2026-09-17。研究对象：不接入服务号回调，每 2 小时全量同步关注者，通过 UnionID 关联小程序用户，业务发送时查询服务号 OpenID。方案拟定的部署约束：单个服务号调度执行者、NestJS、SQLite、定时任务，不引入 Redis；当前生产实例数量尚未确认。

## 结论与证据边界

该方案可以作为**有先决条件的工程设计**：它依赖两个应用能取得同一开放平台范围内的 UnionID，以及服务号具有匹配业务的消息接口权限。轮询只能形成关注状态的快照；两次完整同步之间的关注/取关变化、接口受理之后的最终发送结果都需要承认有信息缺口。

**本次未能直接复核微信服务号官方文档正文，不能据此宣称方案已经通过当前微信平台规则验证。** `web.run` 对旧版和新版官方页面均返回 `cannot be opened (non-retryable error)`；微信官方域名的搜索未返回可采用的官方索引摘录。浏览器工具另因网站安全策略拒绝访问官方文档，明确禁止绕过，未采用原始网络/其他浏览器绕过。搜索出现的第三方转载只用于发现官方链接，不作为规则证据。

本文区分：

- **已读取的官方代码证据**：微信官方 GitHub 组织公开代码及其文档注释。
- **待复核的接口基线**：用来讨论实现的常见字段、参数和约束；对应官方入口已列出，但本次没读到正文，实施前按当前官方文档、账号后台权限和真实响应确认。
- **工程推论**：由轮询、数据库与网络失败机制推出的设计建议，不冒充微信官方规定。

## 已读取的官方代码证据

微信官方 [`wechat-miniprogram/api-typings`](https://github.com/wechat-miniprogram/api-typings) README 的“贡献”说明，API 定义文件随官方文档自动生成。已读取其 [API 类型文件](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)及 [raw 正文](https://raw.githubusercontent.com/wechat-miniprogram/api-typings/refs/heads/master/types/wx/lib.wx.api.d.ts)，可确认以下有限事实：

1. `LoginSuccessCallbackResult.code` 注释指向新版 [code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)，说明后端以 code 换取 OpenID、UnionID、session_key 等信息。
2. `wx.login` 注释把 UnionID 描述为开放平台账号下的标识，并注明小程序需已绑定微信开放平台账号。**这不是服务端 UnionID 下发条件的完整说明。**
3. `wx.getUserProfile` 注释说明其返回的加密数据不包含 OpenID/UnionID，因此不能把申请头像昵称作为 UnionID 缺失时的可靠补救方式。
4. `wx.requestSubscribeMessage` 有 accept/reject/ban/filter 结果；调用订阅界面需要用户点击或支付回调触发。这说明小程序订阅消息有独立的用户订阅流程，不能仅凭已登录/已关注服务号推导订阅许可。

微信官方 [`wx-server-sdk` 类型代码](https://github.com/wechat-miniprogram/wx-server-sdk/blob/master/index.d.ts) 的 `ICloud.BaseWXContext` 把 `UNIONID` 声明为可选字段。它是云开发代码证据，不能替代当前 NestJS 使用的 `jscode2session` 文档，但支持程序必须容忍 UnionID 缺失这一设计原则。

## 身份关联与登录

### 必须区别的两个关系

以下是本方案采用的、**官方正文待复核**的身份基线：

- 用户在小程序和服务号下的 OpenID 分别属于对应 AppID，不能把小程序 OpenID 填进服务号模板消息 `touser`。
- UnionID 的可比较范围是同一个微信开放平台账号下的应用。两个账号同主体、公众号后台关联了小程序，都不能单独当作已完成开放平台绑定的证据。
- “服务号关联小程序”服务于跳转等产品能力；“服务号和小程序绑定到同一开放平台账号”服务于跨应用身份关联。实施前分别核对。

官方待复核入口：[小程序 UnionID 机制](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/union-id.html)、[服务号获取用户基本信息](https://developers.weixin.qq.com/doc/service/api/usermanage/userinfo/api_userinfo.html)、[旧版 UnionID 用户信息文档](https://developers.weixin.qq.com/doc/offiaccount/User_Management/Get_users_basic_information_UnionID.html)。

### `jscode2session` 的实施要求

官方代码证明存在取得 UnionID 的登录路径；完整下发条件本次未能复核。不能断言所有登录响应都有 UnionID，也不能把旧转载里“必须关注同主体公众号”的条件当作当前唯一条件。

工程建议：

- 登录响应同时读取 `openid` 与可选 `unionid`，只有服务端从微信换取的值可以写入业务用户。
- 在 users 增加可空 UnionID。已有用户只存 OpenID 时，关注者同步不能凭空补出其小程序侧 UnionID；下一次有效登录可更新，缺失用户保留为无法关联。
- 微信响应未带 UnionID 时，不清空数据库里既有有效 UnionID；如果未来应用解绑、迁移开放平台账号，需要显式迁移策略，不能把原范围的值继续无条件关联。
- 发送前通过业务接收人身份查 users.unionid，再查本服务号 AppID 范围的关注者记录。本项目 `messages.userId` 实际是小程序 OpenID，必须匹配 `users.wechatOpenId`，不能匹配其 UUID 字段 `users.userId`。暂缺 UnionID 或关联的消息在有效期内等待补齐，到期后 SKIPPED；已明确未关注时直接 SKIPPED，保留站内业务消息。具体有效期以[主方案](/Users/lufy/Desktop/ff/nest/docs/wechat-official-account-push-design.md)为准。

官方待复核入口：[新版 code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)、[旧版 auth.code2Session](https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/login/auth.code2Session.html)。

## 获取关注者列表与用户信息

以下全部属于**方案采用的接口基线，官方正文未能复核，实施前按当前文档和真实响应确认**。

| 接口 | 基线与用途 | 官方待复核入口 |
| --- | --- | --- |
| `GET /cgi-bin/user/get` | 通过 `next_openid` 分页；常见页大小上限为 10000；响应含 `total`、`count`、`data.openid[]`、`next_openid`；它给的是 OpenID 列表，不能只调用它就得到 UnionID | [新版获取关注用户列表](https://developers.weixin.qq.com/doc/service/api/usermanage/userinfo/api_getfans.html)、[旧版获取用户列表](https://developers.weixin.qq.com/doc/offiaccount/User_Management/Getting_a_User_List.html) |
| `GET /cgi-bin/user/info` | 获取单个服务号 OpenID 的关注信息与可选 UnionID | [新版用户基本信息](https://developers.weixin.qq.com/doc/service/api/usermanage/userinfo/api_userinfo.html) |
| `POST /cgi-bin/user/info/batchget` | 通过 `user_list` 批量补全，常见每批上限 100；响应 `user_info_list`；逐条处理 `subscribe` 与缺失 UnionID | [新版批量用户基本信息](https://developers.weixin.qq.com/doc/service/api/usermanage/userinfo/api_batchuserinfo.html)、[旧版用户信息/UnionID](https://developers.weixin.qq.com/doc/offiaccount/User_Management/Get_users_basic_information_UnionID.html) |

`subscribe=0`、取消关注后的信息可见性，以及公众号绑定开放平台账号之后 UnionID 的具体返回条件，都需要复核。稳妥实现应把 UnionID 视为可空，不依赖昵称、头像、性别、地区等字段，不根据早期示例要求这些隐私字段必须返回。不能承诺非关注用户仍可通过此接口补全 UnionID。

### 调用预算

本次无法确认各接口**当前账号的每日调用配额**，不写死“每个账号统一有某个固定额度”。官方待复核入口：[接口调用频次限制](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Interface_Limit.html)。需查看服务号后台实际配额；适用时再核对查询配额接口。

工程预算：若 N 为粉丝数、P 为列表页大小、B 为批量用户信息上限，每 2 小时完整轮询一天 12 轮，则基础调用量约为：

```text
user/get：12 × ceil(N / P)
batchget：12 × ceil(N / B)     （每轮补全所有关注者时）
总基础调用量：12 × (ceil(N / P) + ceil(N / B))
```

上述公式不含重试、发送前确认与终止边界请求；零粉丝也通常需要一次请求才能确认列表为空。以待复核基线 P=10000、B=100、N=10000 估算，为 12 次列表请求加 1200 次批量请求/日。它是容量算术，不代表微信保证配额足够。

## 不接回调时如何同步与处理取关

这是**工程建议**，无需引 Redis即可实现：

1. SQLite 保存每次同步 run 的开始、完成、失败、游标和计数；给每次同步分配 generation。
2. 从第一页开始遍历完整名单；OpenID 去重，检测重复游标/无进展，分页和批量补全都设超时与有限重试。
3. 用 `(oa_appid, openid)` 唯一键 upsert，保存可空 UnionID、subscribe、last_seen_generation、last_checked_at。UnionID 索引带 AppID 范围。
4. **只有整轮列表枚举和全部列表出现标记写入成功后**，才把本轮未出现的旧记录标记为未关注；失败/半轮同步绝不能把未拉到的所有用户误判取关。UnionID 信息补齐的单批失败另行记录重试，不必阻塞已完整取得的列表对账；它与列表完整性是不同维度。
5. 完整轮次成功后记录 completed_at；下一轮失败时保留旧快照，并暴露同步滞后。两小时是调度间隔，故障时状态会比两小时更旧。
6. 进程内锁防止同实例 job 重入；数据库 run 状态辅助重启后恢复与审计。单实例前提必须写入部署约束，未来多实例需换协调机制。

没有关注/取关回调时，取关状态通常只能到下一次成功全量快照才纠正；期间的发送可能被微信拒绝。发送接口若返回明确的“未关注”错误，应立即将该接收者标记为不可发送，并择机用用户信息接口复核。发送前对单个接收者补查可减少旧状态问题，但增加 API 开销，也无法消除“检查后立刻取关”的竞态。

不要把“名单中未出现”升级为“删除业务用户”；这里变化的是消息通道资格，业务身份和站内消息仍有独立用途。

## 选择消息能力

除小程序订阅界面的有限官方代码证据外，下表微信产品约束均为**待复核基线**。不能因为有 OpenID/UnionID，就推导可以无限主动发送任意业务文本。

| 能力 | 方案审查重点 | 官方待复核入口 |
| --- | --- | --- |
| 服务号模板消息 | 目标通道；必须确认账号模板消息权限、匹配业务的模板、发送配额和当前使用规范。按模板字段填充，不能当任意文本/营销群发渠道 | [新版模板消息产品说明](https://developers.weixin.qq.com/doc/service/guide/product/template_message/Template_Message_Interface.html)、[新版发送模板消息](https://developers.weixin.qq.com/doc/service/api/notify/template/api_sendtemplatemessage.html)、[旧版模板接口](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html) |
| 公众号客服消息 | 有用户交互触发条件、时窗和条数限制；常见基线为交互后 48 小时，当前触发动作与额度未复核。每 2 小时拉粉丝本身不等于用户发生客服交互 | [客服消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html) |
| 公众号群发 | 受账号类型、群发次数/频率等约束；单个业务事件给某个小程序用户的通知，不能默认按群发解决 | [群发接口](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Batch_Sends_and_Originality_Checks.html) |
| 公众号订阅通知 | 需要独立确认用户订阅授权、账号权限与模板类型；不能等同于服务号模板消息或小程序订阅消息 | [公众号订阅通知](https://developers.weixin.qq.com/doc/offiaccount/Subscription_Messages/intro.html) |
| 小程序订阅消息 | 用户订阅流程已有官方类型代码证据；一次性/长期模板开放类目、实际发送资格和额度还应按当前文档核对。此通道以小程序用户身份工作，不依赖服务号粉丝全量关联 | [订阅消息能力说明](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)、[发送订阅消息](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-message-management/subscribe-message/sendMessage.html) |

### 模板与小程序跳转

发送请求采用的待复核基线：`touser` 为服务号 OpenID；`template_id` 来自此服务号的已选用模板；`data` 必须匹配实际模板，不复用任意 first/remark/keyword 示例。模板规范与库可能调整，实施前以账号当前模板内容为准。

小程序跳转采用的待复核基线：请求 `miniprogram.appid`、`miniprogram.pagepath`；小程序需与发送公众号建立关联，并使用已发布且可访问的页面。`url` 与 `miniprogram` 的优先关系、小游戏支持与页面路径格式均未读取当前正文，不能仅靠历史转载保证。这里的关联要求与 UnionID 所需开放平台关系分别检查。

官方待复核入口：[发送模板消息](https://developers.weixin.qq.com/doc/service/api/notify/template/api_sendtemplatemessage.html)、[获取已选用模板](https://developers.weixin.qq.com/doc/service/api/notify/template/api_getalltemplates.html)、[选用模板](https://developers.weixin.qq.com/doc/service/api/notify/template/api_addtemplate.html)。

### 统一服务消息：架构备选，当前可用性未验证

历史能力 `uniformMessage.send` 与 `/cgi-bin/message/wxopen/template/uniform_send` 可能提供“小程序 OpenID + 公众号模板”的路径，使微信侧做身份路由；若现行接口仍可用且账号满足条件，有机会减少自行同步服务号 OpenID 的必要性。

**本次没有可读取的当前官方证据，不能确认它仍开放、权限条件或是否接受本项目账号，更不能推荐直接上线。** 不采用第三方旧教程的“调用成功”记录作当前可用性证据。官方待复核入口：[uniformMessage.send](https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/uniform-message/uniformMessage.send.html)。需明确检查接口是否废弃、token 属于哪个 AppID、touser 标识范围、公众号和小程序同主体/关联要求、用户关注条件及返回结果语义，再决定它是否是优先方案。

## access_token 与 stable_token

以下协议细节为**待复核基线**：[旧版获取 access_token](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html)、[旧版稳定版 access_token](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/getStableAccessToken.html)、[新版 access_token](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html)、[新版稳定版 access_token](https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html)。

- 公众号主动 API 使用公众号 AppID/AppSecret 对应的 token，小程序通道使用其相应 token；不能混用。
- 常见响应 `expires_in=7200`；必须按真实响应缓存有效期，不因为同步间隔也是 2 小时就每轮按固定时间重新取 token。
- `stable_token` 普通模式常见基线为有效期内重复请求返回原 token；强制刷新模式可能让之前 token 失效。现行规则和调用限额需复核。
- 不应每次给用户发送消息都重新申请 token；申请/刷新由一个共享 token provider 承担。单实例可以进程缓存 + 刷新 promise 合并，并留过期余量；进程重启后按需获取。SQLite持久化是可选项，部署本身不要求 Redis。
- token 错误只触发一次合并刷新和一次受控重发，避免多个并发发送各自强刷。强刷应只用于已确认 token 失效的情况；配置/权限错误不靠反复刷新解决。
- 服务号接口 IP 白名单、真实出口 IP、账号权限需核对。不要把 AppSecret、access_token、session_key 写进日志或研究文件。

本次没有核实“token 每日 2000 次”等具体数字，也未核实 stable_token 与普通 token 的当前隔离、互相失效规则；不据历史描述断言。

## 受理、送达、重试与错误

### 状态语义

工程上只能根据实际拥有的证据标状态。HTTP 200 仍需解析微信 JSON 中 `errcode`；接口业务成功最多记 **ACCEPTED（微信接口受理）**。不接消息结果回调且没有已核实的结果查询路径时，没有依据记为 DELIVERED 或 READ。

服务号模板消息常见基线为 API 返回 `msgid` 后，发送结果通过 `TEMPLATESENDJOBFINISH` 事件通知。该事件的当前状态与字段本次未复核；官方待复核入口仍是[模板消息接口](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html)。新版目录发现了[查询被拦截模板消息入口](https://developers.weixin.qq.com/doc/service/api/notify/template/api_queryblocktmplmsg.html)，正文不可读，不能把它当所有消息的“最终送达查询”。

建议保留 `provider_msgid`、attempt_count、last_error_code、last_error_message、accepted_at、next_retry_at。没有回执时将 delivered_at 留空；UI 展示“已提交微信”，不要展示“用户已收到”。

### 错误处理基线

以下错误码仅是**方案的待复核候选清单，未在当前官方正文逐项复核**。不同接口的解释可能不同，实施时按所选接口当前错误表和实际响应分类；未识别错误不能全归为可重试。

| 候选错误 | 处理建议（工程策略） |
| --- | --- |
| `40001` / `40014` / `42001` 等 token 错误候选 | 先检查实际 errmsg；合并刷新一次，重发一次；持续失败记录运维告警，不循环强刷 |
| `43004` 未关注候选 | 停止该次推送，将本地通道状态设为不可发送，并复核关注状态；不定时无限重发 |
| `40003` OpenID 错误候选 | 检查 AppID 范围和关联来源；属于标识/配置问题，不能按网络重试 |
| `40037` 模板 ID 错误候选 | 核对模板属于本账号且未被删除；停止无效配置发送 |
| `47003` 模板参数错误候选 | 必须确认所选接口确实使用此码；核对模板字段规则；修配置而非盲重试 |
| `45009` 调用超额候选 | 按配额窗口等待或人工处理；限制积压与消息有效期，避免重试放大 |
| `48001` 接口未授权候选 | 核对账号权限与 token 范围，停止无效配置发送 |
| 系统繁忙/明确临时故障 | 有限退避、加抖动、设最大尝试与业务过期时间 |
| 超时、连接中断、请求后进程崩溃 | 可能已经受理，记 UNKNOWN；不能承诺无重复重试 |

官方待复核入口：[公众号全局返回码](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Global_Return_Code.html)以及具体发送接口错误表。

本地 outbox 唯一业务事件键能防止重复创建待发送消息，但不能消除“微信已受理，响应丢失”后的远端重复。当前模板接口是否有可用去重参数、保证多久、是否需要额外查询，本次未验证；不能宣称本地幂等键就提供端到端恰好一次。

## 实施前需要取得的具体证据

1. 账号后台：服务号类型、认证与有效接口权限；可选用模板真实 ID、内容与配额；实际出口 IP 白名单。
2. 两个平台后台：服务号关联小程序、两者绑定同一开放平台账号；记录分别满足哪一项，而非只写“已绑定”。
3. 脱敏微信响应：小程序有效登录可取得 UnionID；同用户服务号 `user/info`/`batchget` 取得一致 UnionID；对 UnionID 缺失和 subscribe=0 的响应都能处理。
4. 当前官方规则：分页上限、批量上限、每日配额、模板业务范围、跳转要求、稳定 token 生命周期与限额、每种消息能力权限。
5. 验证观察：已关注用户、未关注/取关用户、缺失 UnionID 用户；模板跳转已发布页面；分页中途失败不导致批量误取关；微信业务错误/超时不会误标送达。

这份记录支持主方案的技术设计与待核实项梳理，没有修改业务代码、调用真实微信发送接口、读取或写入敏感配置。
