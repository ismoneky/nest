# 订单数据抢救与回写手册（2026-09-13 事故）

事故状态下**顺序不能错**：`先存档现场 → 再导出 → 才允许重启 → 最后回写`。
重启一次就永久丢掉内存里那批数据，没有第二次机会。

## 1. 事故是什么

并发事务把 sqlite 单连接的 `BEGIN/COMMIT` 记账打坏，留下一个**永远不会提交的开放事务**
（完整机理见 `src/common/transaction-runner.ts` 顶部注释）。后果：

- 进程内的写入**全部返回成功，但只存在于连接内存里**，磁盘上没有；
- 外部以写方式打开 `data/prod.db` 会报 `database is locked`；
- **重启进程 = 这批数据永久消失**。

HTTP 读请求复用同一条连接，所以**只有接口能看见**这份未提交数据 —— 这就是必须先走
`GET` 导出、而不能直接读 `prod.db` 的原因（直接读只会拿到缺数据的旧快照）。

## 2. 为什么不能直接改库

`prod.db` 里缺的正是这批订单。直接对库做修复只能看到残缺状态；必须先把内存里的数据
经接口抢成文件，等进程重启、连接释放后，再把文件补回库。

## 3. 操作步骤

### 步骤 0：先冻结写入（能停就停）

摘掉流量或暂停小程序下单。导出期间线上仍在写入会造成快照不一致——脚本会检测并告警，
但少一批并发写入就少一份麻烦。

### 步骤 1：存档现场（**动手前第一步，不可跳过**）

```bash
cd /app/backend
ls -la data/                      # 看有没有 *.db-journal / *.db-wal / *.db-shm
cp -a data/prod.db "data/prod.db.evidence-$(date +%Y%m%d-%H%M%S)"
for f in data/prod.db-journal data/prod.db-wal data/prod.db-shm; do
  [ -f "$f" ] && cp -a "$f" "$f.evidence-$(date +%Y%m%d-%H%M%S)"
done
```

`-journal` 里可能还留着未提交事务的页，是最后的线索，也是事后追责的唯一凭据。
**不要在重启前删掉它。**

### 步骤 2：导出（进程还活着的时候做）

在服务器上直接打本机端口最稳（不依赖反代和外网）：

```bash
cd /app/backend
cat > curl.txt <<'EOF'
curl 'http://127.0.0.1:3000/admin/bookings?page=1&pageSize=100' \
  -H 'x-admin-key: <ADMIN_API_KEY>'
EOF

node scripts/export-bookings-from-api.js --curl=curl.txt --page-size=100
```

也可以直接用浏览器 DevTools 里的 curl 原文（bash / cmd 格式都认），把整段粘进 `curl.txt`。
脚本会自动改写 `page`/`pageSize` 翻页，其余头（含 `x-admin-key`）原样保留。

**为什么必须翻页**：`GET /admin/bookings` 的 `pageSize` 上限是 `@Max(100)`，传 200 会直接 400。
2 万多条 = 200+ 页，脚本会按 100 一页跑完，并在每页之间留 120ms 间隔。

先空跑一次确认鉴权和字段，再正式拉：

```bash
node scripts/export-bookings-from-api.js --curl=curl.txt --dry-run
```

产出目录 `recovery-export-<时间戳>/`：

| 文件 | 用途 |
| --- | --- |
| `bookings.json` | 交给导入脚本的主文件 |
| `bookings.jsonl` | 每行一条；万一 JSON 损坏可从这里抢救 |
| `meta.json` | 条数、sha256、逐页明细、漂移记录 |
| `raw/page-NNNN.json` | 每页原始响应，取证用，也能在合并出错时重新组装 |

### 步骤 3：核对条数（重启前的最后一道闸）

脚本结尾会打印：

```
条数：21xxx（接口报告 total=21xxx）
sha256：....
```

- **条数 < 接口报告的 total** → 脚本会以退出码 2 告警。**不要重启**，先重跑导出，
  用 `raw/` 下的原始页面对比定位缺了哪几页。
- 提示 `导出期间 total 发生变化` → 说明线上还在写入，快照不一致，`raw/` 已留存。
  评估这个漂移能不能接受，能接受就继续，不能就先冻结流量再重跑。

把 `bookings.json` 和 `meta.json` **拷到服务器之外**（另存一份）。这是重启后唯一的副本。

### 步骤 4：重启进程

先杀干净（确认没有残留的旧连接持锁），再启动：

```bash
pm2 restart <app>        # 或 systemctl restart <service>，按现场部署方式
```

重启后确认库能写：

```bash
sqlite3 data/prod.db "BEGIN IMMEDIATE; ROLLBACK;"
```

不报 `database is locked` 就说明锁已释放。

### 步骤 5：回写（先空跑，再写库）

```bash
cd /app/backend
# 5.1 空跑：只统计，不动库
node scripts/import-bookings-to-db.js --in=recovery-export-xxx/bookings.json --db=data/prod.db

# 5.2 核对统计无误后真正写库（自动备份）
node scripts/import-bookings-to-db.js --in=recovery-export-xxx/bookings.json --db=data/prod.db --apply
```

空跑输出示例：

```
新增：21xxx
更新：0
跳过：0（线上版本相同或更新，保持不动）
冲突：0
异常：0
```

判断标准：

- `新增` = 事故窗口内**新建**的单（磁盘上完全没有）。
- `更新` = 事故窗口内**被改过、但改动没落盘**的单（典型：支付回调把 `unpaid` 改成 `paid`、
  取消退款的 `refundStatus`）。**这是正常且必须写的** —— 不是异常。它们同样只在进程内存里，
  不写回就会留下「用户付过钱、库里还显示未支付」这类账目错乱。
- `跳过` = 线上版本与导出值相同或更新（既没丢也没改），天然占绝大多数。
- 判据是 **`异常` 与 `冲突` 必须为 0**。`新增`/`更新` 的量应当能用事故窗口解释。
- 只有 `更新` 覆盖了几乎全表时才需要停下来核对 —— 那说明导错了库，或快照来自另一套环境。
- `异常` > 0 → 脚本会打印原因，逐条查清再 `--apply`。

`--apply` 时会自动做两份备份，用途不同：

- `data/prod.db.pre-import-<ts>` —— **逻辑一致**的库，写坏了用它回滚；
- `data/prod.db.rawcopy-<ts>` + 归档的 `-journal`/`-wal` —— **原始字节**，取证用。

回滚方法：停服务 → 把 `prod.db.pre-import-<ts>` 覆盖回 `prod.db` → 重启。

### 步骤 6：复核

- 管理端订单列表的「总数」是否与接口报告一致；
- 抽查若干笔已支付订单的 `paymentStatus` / `paidAt` / `transactionId`；
- 抽一笔自驾订单看 `licensePlate` / `vehicleType`，抽一笔看 `passengers` 是否仍是合法 JSON；
- 看 `import-report-<ts>.json` 里的冲突与异常明细。

## 4. 这套脚本的安全承诺

| 承诺 | 实现 |
| --- | --- |
| 不加 `--apply` 绝不写库 | 默认 dry-run，只打印统计 |
| 库被占用时拒绝写入 | 先试 `BEGIN IMMEDIATE`，失败即中止并给出存档/重启指引 |
| 不回退线上更新的数据 | 按 `updatedAt` 比对，线上更新的一律让路；判断条件写进 `UPDATE ... WHERE`，避免竞态 |
| 可重复执行 | 以 `bookingId` 为唯一键 + 版本比对，天然幂等，断点续跑安全 |
| 不搬自增 id | `id` 是本地产物，更新时显式排除；新增时若 id 被别的订单占用则改由 sqlite 分配并留痕 |
| 类型不被写脏 | ISO 字符串 → 毫秒整数、`boolean` → `0/1`、`date` → `YYYY-MM-DD` |
| 文件被改动会被发现 | `meta.sha256OfBookings` 校验，对不上拒绝 `--apply` |
| 字段对不上会中止 | JSON 字段与表结构不匹配时默认中止，需显式 `--allow-shape-drift` |

回归测试：`npm run test:diagnostics`（`test/diagnostics/booking-recovery.test.js`，15 个用例，
含锁占用拒写、幂等、版本让路、id 冲突、类型还原、curl 翻页端到端、**备份可回滚**）。

> 备份那条用例断言的是「逻辑备份非空 + 能独立打开 + 内容等于导入前的行数」。
> 早期只断言文件名里有没有 `.pre-import-`，于是 `db.backup()` 产出 0 字节文件时测试照样全绿 ——
> 而那正好对应最坏的剧本：按手册回滚会把生产库覆盖成一个空文件。现已改用 `VACUUM INTO`。

## 5. 其他表怎么办

`GET /admin/bookings` 只覆盖订单表 `bookings`。**如果事故窗口内别的表也发生了写入**
（`users` / `members` / `feedbacks` / `announcements` / `app_logs`…），它们的数据同样只在内存里，
但接口未必提供全量列表 —— 那部分数据**没有导出通道就无法抢救**，要在重启前评估清楚。

若某张表有可用的全量 GET，导入脚本可复用（列结构由 `PRAGMA table_info` 现场读取）：

```bash
node scripts/import-bookings-to-db.js --in=xxx.json --db=data/prod.db --table=members
```

注意：脚本按 `bookingId` 做唯一键匹配，其他表的主键字段不同，复用前需先调整匹配键。

## 6. 注意事项

- **个人信息**：导出文件含乘客姓名、手机号、身份证号。`recovery-export-*/` 已加入 `.gitignore`，
  请勿提交仓库或发到聊天工具；用完按合规要求销毁。
- **目标库路径**：导入脚本要求库文件已存在，不会替你新建（避免在错误路径上「成功」导入到空库）。
- **别在导出期间重启**：导出没拿到完整条数之前，任何重启都会永久丢数据。
- **时区**：`bookingDate` 以 `YYYY-MM-DD` 原样保留，不参与时区换算；时间戳列存毫秒 epoch。
  服务器应为 UTC+8，与 TypeORM 写入语义一致。

## 7. 建议的后续修复（另排期）

- 按 `transaction-runner.ts` 的约定，把仓库里剩余的 `dataSource.transaction` / `repo.save`
  全部换成 `serialTransaction` / `serialSave`，把事故触发条件彻底移除。
- 启用 WAL 与 `synchronous=NORMAL`（此前按支付可靠性设计未启用，需单独验证后决策）。
- 给订单表加定期逻辑备份（`VACUUM INTO`）与可轮转的导出，避免下次只能靠进程内存抢数据。
