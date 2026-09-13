#!/usr/bin/env bash
#
# 上传当前项目（参照 upload.sh，只改了两处）
#   1. 路径不写死：用脚本自身所在目录，在哪台机器 clone 就在哪台跑
#   2. 补上传订单数据 json 与操作手册（upload.sh 里没有这两条）
#
# 只做 scp 传文件：不 ssh 预检、不 mkdir、不重启服务、不动 data/。
# 本机没有 certs/ 目录，那条已注释掉。

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "本地目录：$(pwd)"

HOST=root@82.157.111.208
REMOTE=/app/backend

# 每个 scp 只问一次密码，免得输错还要连问三次
SCP="scp -o NumberOfPasswordPrompts=1"

rm -rf dist
npm run build

$SCP -r package.json      $HOST:$REMOTE/package.json
$SCP -r package-lock.json $HOST:$REMOTE/package-lock.json
$SCP -r dist/*            $HOST:$REMOTE/dist/
# $SCP -r certs/*         $HOST:$REMOTE/certs/          # 本机没有 certs/，跳过
$SCP -r .env              $HOST:$REMOTE/.env
$SCP -r scripts/*         $HOST:$REMOTE/scripts/

# —— upload.sh 里没有的（本次事故恢复要用）——
$SCP -r recovery-export-20260913-b/bookings.json $HOST:$REMOTE/bookings.json
$SCP -r docs/booking-recovery-runbook.md         $HOST:$REMOTE/booking-recovery-runbook.md

echo "传完了。"
