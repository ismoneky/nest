#!/usr/bin/env bash
#
# 上传到【生产环境】：/app/backend（upload2.sh 的产线版，只改了目标）
#
# 只做两件事：本地构建 + scp 传文件。
# 不 ssh、不重启、不动 .env、不动 data/。
#
# 传完记得自己上服务器执行重建，否则不生效：
#     cd /app/backend && ./build2.sh
# 原因：Dockerfile 是 `COPY dist ./dist`，代码在 docker build 时打进镜像；
# 容器只 bind 了 data/certs/logs，dist 不在其中。只传文件，跑的还是旧镜像。
#
# 用 bash 调用：bash upload-prod.sh
# 直接敲 ./upload-prod.sh 的话，Windows 会走 .sh 的文件关联（git-bash.exe）
# 另开一个窗口，输出和报错一闪就关了 —— 看不见失败等于没有失败。

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "本地目录：$(pwd)"

HOST=root@82.157.111.208
REMOTE=/app/backend

# 每个 scp 只问一次密码
SCP="scp -o NumberOfPasswordPrompts=1"

echo
echo "目标：$HOST:$REMOTE  【生产】"
echo

rm -rf dist
npm run build

$SCP -r package.json      $HOST:$REMOTE/package.json
$SCP -r package-lock.json $HOST:$REMOTE/package-lock.json
$SCP -r dist/*            $HOST:$REMOTE/dist/
$SCP -r scripts/*         $HOST:$REMOTE/scripts/

echo
echo "传完了。接着上服务器执行：cd $REMOTE && ./build2.sh"
