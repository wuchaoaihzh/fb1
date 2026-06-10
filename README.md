# Facebook Opportunity Radar

Facebook Opportunity Radar 是一个从零搭建的本地工具骨架，用于在 Chrome / Chromium / AdsPower 浏览器中读取当前页面已经加载、用户可正常看到的 Facebook 群组帖子，并把帖子发送到 Windows 桌面 UI 中做去重、关键词匹配、规则评分、提醒和导出。

本项目不包含自动评论、自动发送 Facebook 内容、绕过登录、账号批量管理或权限突破功能。最终评论和业务判断必须由用户人工完成。

## 目录结构

```text
facebook-opportunity-radar/
  package.json
  README.md
  shared/
    src/
      types.ts
      defaults.ts
      time.ts
      scoring.ts
      dedupe.ts
  desktop-app/
    src/main/
      main.ts
      preload.ts
    src/renderer/
      main.tsx
      styles.css
  browser-extension/
    manifest.json
    src/
      background.js
      content.js
    popup/
      popup.html
      popup.css
      popup.js
    options/
      options.html
```

## 当前 MVP 已包含

- Electron + React + TypeScript 桌面应用骨架
- 本地 HTTP / WebSocket 服务：`127.0.0.1:8765`
- Chrome Manifest V3 插件骨架
- 插件 popup 显示本地应用连接状态
- 插件向桌面端发送测试帖子
- content script 采集当前可见 Facebook 页面 DOM 中的候选帖子
- 桌面 UI 实时显示帖子列表、统计、连接数和采集状态
- 基础关键词匹配、规则评分、新帖判断和去重
- 声音提醒、窗口闪动、桌面通知
- 自动滚动指令和次数设置
- CSV / Excel 导出
- 本地 JSON 持久化和日志文件

## 开发启动

先安装依赖：

```bash
npm install
```

启动桌面应用：

```bash
npm run dev
```

桌面端启动后会打开本地服务：

```text
http://127.0.0.1:8765
ws://127.0.0.1:8765
```

## 安装 Chrome / AdsPower 插件

1. 打开 Chrome、Chromium 或 AdsPower 的扩展管理页面。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目的 `browser-extension/` 目录。
5. 打开桌面应用。
6. 在 Facebook 群组页面点击插件图标，确认显示“已连接”。
7. 可先点击“发送测试帖子”，验证桌面 UI 是否实时显示测试数据。

## 使用流程

1. 打开桌面 UI 应用。
2. 打开 AdsPower。
3. 进入 Facebook 群组页面。
4. 确认插件已连接桌面应用。
5. 设置滚动次数和提醒条件。
6. 点击“开始采集”。
7. 手动滚动页面，或在桌面端点击“开始自动滚动”。
8. 发现新需求帖后，桌面应用会声音提醒、窗口闪动并高亮帖子。
9. 点击“打开帖子”，进入 Facebook 页面人工查看并评论。
10. 需要时导出 Excel 或 CSV。

## 打包 Windows 应用

```bash
npm run package:win
```

生成结果在：

```text
desktop-app/release/
```

## 数据和日志

桌面应用会把数据写入 Electron 的用户数据目录。可在 UI 中点击“数据目录”打开，里面包含：

- `posts.json`
- `settings.json`
- `radar.log`
- 导出的 `facebook_posts_YYYY-MM-DD_HH-mm-ss.xlsx`
- 导出的 `facebook_posts_YYYY-MM-DD_HH-mm-ss.csv`

## 后续开发优先级

第一阶段继续加强：

- Facebook 真实帖子 DOM 识别稳定性
- photo / `fbid` / `set=pcb` 页面时间识别
- 关键词管理 UI 的增删改、启用禁用、导入导出
- 日志查看页面
- 更完整的帖子详情页和状态标记

第二阶段：

- 多语言时间识别
- 更强 URL 标准化和跨链接形式去重
- Windows exe 打包验证
- 历史数据分析

第三阶段：

- 可选 AI 评分接口
- 需求类型自动分类
- 多窗口来源备注和群组管理
