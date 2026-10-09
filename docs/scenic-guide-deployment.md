# 景区导览第一版部署

## 数据库

生产环境关闭 synchronize，部署代码不会自动创建导览表。部署新后端前请备份 SQLite 主数据库，并执行 [deploy-scenic-guide.sql](./deploy-scenic-guide.sql)：

```sql
CREATE TABLE IF NOT EXISTS scenic_guides (
  id INTEGER PRIMARY KEY NOT NULL,
  contentJson TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updatedAt INTEGER NOT NULL
);
```

无须插入初始数据。管理员首次保存创建 id=1 配置；未设置底图时小程序显示“景区导览正在准备中”。

### 已上线后报 `SQLITE_ERROR: no such table: scenic_guides`

这是主库漏执行建表 SQL。先确认 Nest 运行时的 `DATABASE_PATH`；若未配置，默认是 Nest 工作目录下的 `data/app.db`。不要把 SQL 执行到 `LOG_DATABASE_PATH` 指向的日志库，或根据示例路径另建一个空库。

在服务器 Nest 项目目录中执行下面的命令，将第一行替换为实际主库路径：

```sh
GUIDE_DB='/实际路径/主数据库.db'
test -f "$GUIDE_DB" && sqlite3 -bail "$GUIDE_DB" ".backup '$GUIDE_DB.before-guide-$(date +%Y%m%d-%H%M%S).bak'" && sqlite3 -bail -cmd '.timeout 5000' "$GUIDE_DB" < docs/deploy-scenic-guide.sql
sqlite3 -readonly "$GUIDE_DB" 'PRAGMA table_info(scenic_guides);'
```

最后应输出 `id`、`contentJson`、`revision`、`updatedAt` 四列。随后刷新 admin 导览页即可，已部署的 Nest 和 admin 不需要重新构建。SQL 可以重复执行，不会覆盖已有导览数据。若依然报错，核对错误中的表名、实际数据库路径，以及 admin 是否请求了另一个后端环境。

COS 配置只影响上传图片，读取导览配置和建表不依赖 COS。

## 腾讯云 COS 直传

浏览器直接向 COS 上传图片。业务服务器只接收文件类型/大小、生成10分钟有效的 POST policy，并保存 CDN 链接，不接收或存储文件。

服务端配置 .env.cos.example 中的 COS_BUCKET、COS_REGION、COS_SECRET_ID、COS_SECRET_KEY、COS_PUBLIC_BASE_URL。密钥仅放服务端环境变量，禁止放到前端或提交 Git。

- COS_PUBLIC_BASE_URL 是映射 bucket 根目录的 HTTPS CDN 域名（或公开可读的 COS 域名），不带查询参数。私有桶加 CDN 回源鉴权时，确保新对象可通过该 CDN 读取。
- 上传限定 scenic-guide/YYYY-MM-DD/uuid.ext 随机对象键、指定 MIME 和文件大小（最大10 MiB）。建议子账号只允许写入该 bucket 的 scenic-guide/* 前缀。
- COS 跨域规则允许后台实际 origin（协议、域名、端口），允许 POST 和 Content-Type；可以暴露 ETag。开发时单独加入本地 origin。
- 缺少 COS 配置时返回明确提示，仍能填写已有 HTTPS 图片链接。
- 上传后未保存配置的对象会留在 COS；删除地点不删除云端对象，以免误删被其他内容引用的图片。
- 小程序合法下载域名添加实际 CDN 域名。展示地址使用 CDN 永久链接，不能使用短期上传凭证地址。

协议依据：[腾讯云 Web 端直传实践](https://cloud.tencent.com/document/product/436/9067)。POST policy 由 COS 执行单对象路径、大小和类型约束。

## 发布顺序与验收

1. 执行建表 SQL，配置 COS 环境变量与 CORS，部署后端。
2. 部署 admin，进入“景区导览”，上传底图（参考原图在 fctl/docs/scenic-guide/reference.jpg），新增地点、拖动定位、保存并刷新。
3. 发布小程序，检查“首页 / 导览 / 预约 / 我的”四个入口及未读红点。
4. 后台隐藏地点后，公开接口和小程序都不显示该交互点；底图固有文字与红点仍保留。
5. 在 iOS/Android 微信真机验证双指缩放、点位对齐、筛选、失败重试与安全区。

第一版无真实地图或游客实时定位。每个地点必须配置成对有效的 GCJ-02 经纬度，才能保存并提供“导航前往”。不能从图片像素推算经纬度。
