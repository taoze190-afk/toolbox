#!/usr/bin/env bash
# 一次性安装自建文档转换服务（Debian 12/13，1panel 所在机器）
# 在 1panel 左侧「终端」里整段粘贴执行即可。重复执行是安全的（幂等）。
# 本文件由 tools/gen-install.mjs 从 server/install.tpl.sh 生成，服务端代码与自检样本会被内嵌进来。
set -euo pipefail

PORT=${PORT:-29000}
DIR=/opt/docconv
MEM_LIMIT=512M

if [ "$(id -u)" != "0" ]; then echo "请用 root 执行"; exit 1; fi

echo ">>> 1/6 装 LibreOffice 无界面组件和中文字体"
# 组件包必须全部带 -nogui 后缀。混装 GUI 版（libreoffice-calc 等）会和 libreoffice-core-nogui
# 冲突，apt 直接报 "you have held broken packages" 并整批拒绝。
# fonts-noto-cjk 必须有，否则中文转出来全是方框。
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  libreoffice-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
  libreoffice-draw-nogui \
  fonts-noto-cjk ca-certificates curl

command -v soffice >/dev/null || { echo "    soffice 没装上"; exit 1; }
echo "    $(soffice --version | head -1)"
fc-list :lang=zh 2>/dev/null | head -1 | grep -q . || echo "    警告：没找到中文字体，中文会出方框"

echo ">>> 2/6 真做一次 docx 转 PDF，确认过滤器装齐"
mkdir -p "$DIR"
base64 -d > /tmp/selftest.docx <<'B64'
%%SELFTEST_B64%%
B64
rm -rf /tmp/selftest-out && mkdir -p /tmp/selftest-out
# 只用实测过能被接受的参数组合。多加 --nolockcheck / --nodefault / --env:UserInstallation
# 会让 soffice 吐一篇帮助文本然后退出，转换根本没发生。
timeout 300 soffice --headless --norestore \
  --convert-to pdf --outdir /tmp/selftest-out /tmp/selftest.docx > /tmp/selftest.log 2>&1 || true
GEN=$(ls /tmp/selftest-out/*.pdf 2>/dev/null | head -1 || true)
if [ -n "$GEN" ] && head -c 4 "$GEN" | grep -q PDF; then
  echo "    通过：$(basename "$GEN") $(stat -c %s "$GEN") 字节"
else
  echo "    没有产出 PDF，soffice 的输出如下："
  tail -20 /tmp/selftest.log | sed 's/^/      /'
  rm -rf /tmp/selftest-out /tmp/selftest.docx /tmp/selftest.log
  exit 1
fi

rm -rf /tmp/selftest-out /tmp/selftest.log

echo ">>> 3/6 放服务代码并确认 node 可用"
cat > "$DIR/convert-server.mjs" <<'CONVJS'
%%SERVER_JS%%
CONVJS

if ! command -v node >/dev/null; then
  echo "    没装 node，先装（或在 1panel「运行环境」里装 node）"
  apt-get install -y -qq nodejs
fi
echo "    node $(node --version)"

echo ">>> 4/6 生成访问令牌"
TOKEN_FILE="$DIR/token"
# 默认复用已有令牌（换域名、重装都不用重填 App）。要作废旧令牌时：ROTATE=1 bash install.sh
if [ "${ROTATE:-0}" = "1" ]; then
  echo "    ROTATE=1：作废旧令牌，重新生成"
  head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28 > "$TOKEN_FILE"
elif [ ! -s "$TOKEN_FILE" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28 > "$TOKEN_FILE"
fi
TOKEN=$(cat "$TOKEN_FILE")

echo ">>> 5/6 注册 systemd 服务（只绑回环、限内存 $MEM_LIMIT、单并发）"
# heredoc 千万别加引号：加了 $PORT/$TOKEN/$DIR 就不会被替换，
# systemd 也不认这些 shell 变量，服务会因为路径是空的而起不来。
cat > /etc/systemd/system/docconv.service <<UNIT
[Unit]
Description=自建文档转换服务
After=network.target

[Service]
Type=simple
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=TOKEN=$TOKEN
Environment=SOFFICE=/usr/bin/soffice
Environment=MAX_MB=40
Environment=TIMEOUT_S=300
ExecStart=/usr/bin/env node $DIR/convert-server.mjs
Restart=on-failure
RestartSec=3
MemoryMax=$MEM_LIMIT
MemoryHigh=384M
ProtectSystem=full
ReadWritePaths=$DIR /tmp
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now docconv

echo ">>> 6/6 自检"
ok=0
for i in $(seq 1 10); do
  if curl -fsS -m 5 "http://127.0.0.1:$PORT/health" -H "Authorization: Bearer $TOKEN" >/dev/null; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = "1" ]; then
  echo "    服务应答正常"
  if curl -fsS -m 120 -X PUT --data-binary @/tmp/selftest.docx \
      -H "Authorization: Bearer $TOKEN" \
      "http://127.0.0.1:$PORT/convert?from=docx&to=pdf" -o /tmp/e2e.pdf && head -c 4 /tmp/e2e.pdf | grep -q PDF; then
    echo "    端到端通过：经服务转出 PDF $(stat -c %s /tmp/e2e.pdf) 字节"
  else
    echo "    服务起来了但端到端转换失败，看日志： journalctl -u docconv -n 30 --no-pager"
    exit 1
  fi
else
  echo "    服务没应答。状态与日志如下："
  systemctl --no-pager -l status docconv 2>&1 | head -15 | sed 's/^/      /'
  journalctl -u docconv -n 30 --no-pager 2>&1 | sed 's/^/      /'
  exit 1
fi

echo
echo "=========================================================="
echo "   服务监听   127.0.0.1:$PORT   （只绑回环，外网打不进来）"
echo "   访问令牌   $TOKEN"
echo
echo " 还差最后一步：在 1panel 建反向代理站点，把它暴露成 https"
echo "   网站 → 创建网站 → 类型选「反向代理」"
echo "     域名       你的域名（如 doc.example.com）"
echo "     监听端口   29433（HTTPS）"
echo "     代理地址   http://127.0.0.1:$PORT"
echo "   建好后去「网站设置 → HTTPS」申请证书，验证方式选 DNS（家宽 80 端口常被运营商封）"
echo "   再到「网站设置 → 配置文件」加两行："
echo "     client_max_body_size 40m;"
echo "     proxy_read_timeout 180s;"
echo "=========================================================="
echo " App 里最终填： https://你的域名:29433"
echo " 路由器映射和 1panel 防火墙要放行的都是 29433，不是 $PORT。"
echo " 服务只绑了回环，从外面直连 $PORT 不通是预期行为，不是故障。"
echo " 查看日志： journalctl -u docconv -f"
echo " 停用：     systemctl stop docconv"
echo " 彻底删除： systemctl disable --now docconv && rm -f /etc/systemd/system/docconv.service && rm -rf $DIR"
