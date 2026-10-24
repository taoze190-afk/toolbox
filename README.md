# 全能工具箱

17 个文档与图片处理工具，文件在设备本地处理，不上传。网页版和 Android 版同一套代码。

## 工具清单

压缩与证件照：图片压缩、PDF 压缩、GIF 压缩、音频压缩、证件照片压缩、证件尺寸修改
转换：PDF 转 Word、PDF 转 Excel、PDF 转 PPT、PDF 转长图、PDF 逐页转图、图片转 PDF、图片转 Word、图片转 Excel、Word 转 PDF、PPT 转 PDF、Excel 转 PDF

图片转 Word / Excel 走 tesseract.js 离线识别，中英文语言包随包，飞行模式也能用。

## 技术栈

React 19 · TypeScript · Vite 6 · Tailwind CSS 4 · Capacitor 8

PDF 读写用 `pdfjs-dist` 与 `pdf-lib`，图片压缩走浏览器 canvas，GIF 用 `gifsicle-wasm-browser`，MP3 编码用 `@breezystack/lamejs`，Office 文件由 `mammoth`、`docx`、`exceljs`、`pptxgenjs` 读写。`sharp` 只在 `tools/` 里生成和解析夹具，不参与运行时。

Word、PPT、Excel 转 PDF 由本地按版式重新排版，不是像素级还原。要原版式，在设置页接一个自建 LibreOffice 服务，或填 CloudConvert / ConvertAPI 的密钥。

## 已知限制

- Word 转 PDF 的产物每页是整幅图像，没有文字层；分栏、页眉页脚、目录域和脚注不参与排版
- PDF 压缩同样整页转图，文字版 PDF 压完会丢文字层，工具会明确提示
- PDF 转 Word / Excel / PPT 只重建文字与表格结构，版式和图片位置不保留
- 只支持 .docx/.xlsx/.pptx，老的 .doc/.xls/.ppt 不认
- 中文 OCR 识别率有限，语言包只随包了简体中性和英文

## 本地运行

需要 Node 22 或更高。

```bash
npm install
npm run dev        # http://127.0.0.1:5175
```

## 打 Android 包

```bash
npm run apk            # debug 包
npm run apk:release    # release 包
```

脚本会依次跑 `vite build`、`cap sync android`、`gradlew assemble`，然后把包拷到仓库根目录，再用 `aapt2` 解包核对包名和图标。构建前需要 JDK 21 与 Android SDK，路径写在 `tools/local.json`（见下）。

## 验证

```bash
npm run typecheck
npm run fixtures       # 生成夹具文件到 fixtures/
npm run verify         # 无头 Chrome 里真跑 37 条用例，解析产物内容后断言
```

`npm run verify` 会起一个预览服务器并把每个工具的产物拉回 Node 侧解析：页数、尺寸、体积、文字内容都要对上才算过。构建日志里的 "BUILD SUCCESSFUL" 不作为通过依据。

真机验证：`node tools/build-apk.mjs --test` 打出带测试钩子的包，装上后跑 `node tools/device-verify.mjs`。

## 自建转换服务

`server/convert-server.mjs` 是一个只监听 127.0.0.1 的 LibreOffice 包装服务，令牌鉴权。

```bash
node tools/gen-install.mjs      # 生成 server/install.sh
```

把 `server/install.sh` 拷到服务器上 `bash install.sh`，它会装 LibreOffice、建 systemd 服务、自检一轮，最后打印出要填进 App 的地址和令牌。建议用 1panel 建反向代理套上 HTTPS，只映射一个高位端口。

`server/.token` 是本机令牌，已在 `.gitignore` 里，不要提交。

## 目录

```
src/core      引擎：文件读写、图片、PDF、OCR、任务队列、设置
src/tools     每个工具的参数面板与执行逻辑
src/ui        首页、侧栏、路由、外壳
public        随包的 wasm、worker、cmap、语言包
tools         构建与验证脚本
server        自建转换服务
```

## 本机配置

`tools/` 下的脚本要用到本机的 adb、JDK、SDK、ffmpeg、Chrome 路径和你的设备号。这些值不入库：

```bash
复制 tools/local.example.json 为 tools/local.json，把里面的值改成你自己的路径
```

`tools/local.json` 已被忽略，缺项时脚本会直接报出该填哪一项。

## 安装

Releases 里有调试签名的 APK，装了就能用，数据只存本机。

## 许可

未附许可证文件，版权归作者所有。
