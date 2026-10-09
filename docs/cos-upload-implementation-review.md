# 景区导览 COS 上传方案核对

核对日期：2026-10-08。范围为当前源代码和腾讯云官方文档；未连接生产 COS、未上传对象、未读取密钥，也未修改实现。

## 结论

当前「后端签发短期 POST policy → 浏览器 FormData 直传 COS → 保存 CDN 链接」是腾讯云官方支持的方案，并非为了直传额外绕了一层文件服务器。用户提供的 [JavaScript SDK 上传对象文档（64960）](https://cloud.tencent.com/document/product/436/64960)展示 `putObject` / `uploadFile`，但其“表单上传对象”一节也明确说明 SDK 没有 POST Object 方法，并链接到 Web 端直传实践的 AJAX POST 实现。

需要区分两件事：浏览器上传需要受控授权；授权不一定要使用 POST policy。SDK 的短代码示例省略了初始化和授权过程。官方[快速入门](https://cloud.tencent.com/document/product/436/11459)推荐生产使用临时凭证，由服务端申请后返回前端，并在凭证接口验证登录态；也支持 `getAuthorization` 返回服务端生成的签名。将永久 SecretKey 放入浏览器、Vite 环境变量或前端包，不是合适的简化。

对目前单张 JPEG/PNG/WebP、最大 10 MiB 的场景，当前实现很小，且能够在 COS 侧限制单对象路径、MIME 元数据和大小。没有证据说明为了遵循 64960 必须改 SDK。若需要进度、断点续传、暂停或批量上传，SDK 更有价值。判断来自当前需求与官方能力的比较，而非腾讯云要求本项目采用某一种实现。

## 官方方案与当前代码

| 项目 | 官方依据 | 当前实现 |
| --- | --- | --- |
| 服务端授权，浏览器发送文件 | [Web 端直传实践（9067）](https://cloud.tencent.com/document/product/436/9067)：服务端生成随机对象路径与签名，浏览器用 PUT 或 POST 上传；生产签名接口应鉴权 | [controller](../src/modules/scenic-guide/scenic-guide.controller.ts) 的 upload-policy 使用 AdminAuthGuard；API 只收类型和大小 |
| AJAX POST | [9067 的 AJAX POST 示例](https://cloud.tencent.com/document/product/436/9067)使用后端 policy、FormData、最后追加 file | [前端上传](../../admin/src/api/scenicGuide.ts)遵循相同流程，独立 fetch、不带后台 API key 或 cookies |
| POST 签名与范围约束 | [POST Object API](https://cloud.tencent.com/document/api/436/14690)定义独立签名算法、policy、匹配条件与表单字段 | [签名服务](../src/modules/scenic-guide/guide-upload.service.ts)生成唯一 key、600 秒有效期、Content-Type、1..size 范围 |
| 大小必须由 COS 执行 | [限制上传文件大小和类型](https://cloud.tencent.com/document/product/436/54370)说明 POST policy 的 content-length-range 限制文件长度；STS 也可限制 PutObject/PostObject 大小 | 本地校验之外，签名 policy 将 size 限制到最大 10 MiB；multipart 包装开销不属于该文件长度 |
| 展示地址 | [部署约定](./scenic-guide-deployment.md)、[已确认设计](../../fctl/docs/superpowers/specs/2026-10-06-scenic-guide-design.md)要求 CDN 永久链接 | uploadUrl 是 COS 写入域名；imageUrl 是配置的 CDN 根域名加对象 key |

## 正确性与实际边界

源码核对未发现明确的 POST 签名算法错误：`SignKey = HMAC-SHA1(SecretKey, KeyTime)` 的十六进制字符串作为下一次 HMAC 的 key，`StringToSign = SHA1(policy JSON)`，最终 HMAC 后再把 policy Base64 编码。policy 使用 `q-sign-time`，表单使用 `q-key-time`，看似不一致，但正是[官方 POST Object 示例](https://cloud.tencent.com/document/api/436/14690)的写法，不能据此直接改名。204 成功状态和 file 最后追加同样符合协议。

需要保留以下边界，避免文档把保证说得过大：

1. **MIME 与尺寸是元数据限制，不是文件内容鉴定。** 后端只看调用方传来的 contentType/size；浏览器正常路径会解码图片取得尺寸，但管理员可直接调用 API。COS 的 Content-Type 是对象元数据，而非证明字节确实为 PNG/JPEG/WebP。当前可信管理员场景可以接受；若未来开放给不可信上传者，需要内容检测/审核流程。[当前前端](../../admin/src/api/scenicGuide.ts)、[签名服务](../src/modules/scenic-guide/guide-upload.service.ts)、[官方类型限制定义](https://cloud.tencent.com/document/product/436/54370)。
2. **短期单对象授权不等于一次性授权。** policy 未绑定文件摘要，且允许 1..size，而不是精确 size。在有效期内可重复对同一 key 上传、替换为其他满足约束的内容。UUID 避免不同授权通常碰撞，但不阻止同一授权重放；COS 未启用版本控制时，同名写入覆盖已有对象。[签名服务](../src/modules/scenic-guide/guide-upload.service.ts)、[POST Object 的覆盖语义](https://cloud.tencent.com/document/api/436/14690)。
3. **云端账号权限仍需落实。** 部署文档“建议子账号只允许写前缀”应变为实际配置要求：仅授予该桶 `scenic-guide/*` 的 `cos:PostObject`，避免用主账号或附带删除/ACL 修改权限的账号签发。当前代码没有 STS/sessionToken 支持；普通永久子账号签名可用，若配置临时密钥则需要相应 token。对未限定的可选 ACL/元数据字段还应明确策略，不能仅靠前端不发送；具体风险受 IAM 权限约束，尚未实测。[官方授权和可限定字段](https://cloud.tencent.com/document/api/436/14690)、[部署说明](./scenic-guide-deployment.md)。
4. **COS 写成功不保证 CDN 可读。** 代码根据 COS 2xx 返回 imageUrl，没有检查 CDN 回源权限、域名映射或新对象可访问性；部署必须确认配置的 base URL 映射桶根目录。代码 URL 校验允许带 pathname，实际部署说明要求根目录映射，应统一这一约定。[上传返回逻辑](../../admin/src/api/scenicGuide.ts)、[base URL 校验](../src/modules/scenic-guide/guide-upload.service.ts)、[部署约定](./scenic-guide-deployment.md)。
5. **现有测试不证明真实 COS 上传成功。** [后端测试](../src/modules/scenic-guide/scenic-guide.spec.ts)检查 policy 条件、有效期、签名格式和不泄露 SecretKey，但没有独立计算签名对比，也不请求 COS；[前端测试](../../admin/tests/scenic-guide.test.mjs)主要覆盖导览 model，未覆盖 uploadGuideImage。上线验收应使用测试桶验证合法图片、错误 key/MIME、超限文件、过期 policy 和 CDN 读取；这些云端行为目前未经本次研究验证。

## 可选择的简化

| 选择 | 代价与适用条件 |
| --- | --- |
| 保留当前 POST policy | 当前小图片场景最小改动；无前端 COS SDK/STS 依赖，保留大小和 MIME 条件。先补真实桶验收与错误诊断即可。 |
| 后端签发 PUT 授权，前端 `fetch(url, {method: 'PUT', body: file})` | 去掉 FormData，官方 [9067](https://cloud.tencent.com/document/product/436/9067)推荐此方式；仍需要受保护的后端签名接口。若继续要求 COS 强制大小限制，不能只删 POST policy，需另配 STS 条件或合适的云端控制。CORS 也要改为 PUT 和实际签名请求头。 |
| 后端 STS + `cos-js-sdk-v5.putObject` | 最贴近 [64960](https://cloud.tencent.com/document/product/436/64960) 的简单上传示例；前端调用更短，但总体新增 SDK、STS、token 和过期处理。服务端须限制对象 key、动作、有效期与大小。 |
| 后端 STS + SDK `uploadFile` | 更适合批量/大文件、进度和断点续传；默认超出 1 MiB 即可能走分块上传，需要额外分块动作权限，不能直接沿用仅 PostObject 的授权。[SDK 文档](https://cloud.tencent.com/document/product/436/64960)。 |
| COS 控制台手动上传后填写 HTTPS 链接 | 若只发布一次底图，这是运维上最简单的路径；当前已有链接入口可用，但它取消了后台选文件直接上传的体验。[部署说明](./scenic-guide-deployment.md)。 |

推荐：目前保留 POST policy；若用户偏好官方 SDK，使用已鉴权的服务端 STS 接口加 `putObject`，不要把永久密钥移动到前端。没有进度/续传需求时，不必为了调用看起来更短而引入 `uploadFile` 分块链路。

本次通过浏览器核实了 64960、11459、9067 页面正文；网页抓取工具对部分页面超时，结论不依赖二手文章。此文是源码与协议评审，不代表生产 IAM、CORS、CDN 或真实上传已验证。
