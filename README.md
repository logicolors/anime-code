# 动画代号 · Anime Code

动漫版的行动代号（Codenames）。红蓝两队各有一名队长，队长根据只有自己看得到的地图给出「一个词 + 一个数字」的提示，猜词人据此在 5×5 的动画牌中找出本队作品，先找齐的一队获胜，翻到刺客牌直接失败。

支持房间联机（服务端负责身份权限、投票判定与回合限时，房主浏览器负责发牌），也保留同屏练习模式。数据来源：[Bangumi](https://bgm.tv)。

## 玩法

1. 填写昵称「创建房间」，把六位房间号发给朋友加入。
2. 每队选一名队长、至少一名猜词人（最多 16 名玩家，观战人数不限），全员准备后由房主开局。
3. 当轮队长发布提示，猜词人投票选牌并「翻开」：翻到己方牌可继续，翻到中立或对方牌换人，翻到刺客本队立即失败。
4. 游戏内点「?」或首页「如何游玩」可查看分步演示。

房主可在大厅「调整牌池」（评分人数、年份、评分、标签筛选）和「详细设置」（投票门槛、每轮翻牌上限、队长禁牌等）中修改规则。

## 运行

需要 Node.js 20 或更新版本。联机部分运行在 Cloudflare Workers 上：Worker 提供静态文件，每个房间是一个 Durable Object。

```bash
npm ci
npm start
```

`npm start` 通过 `wrangler dev` 在本地运行，打开 http://localhost:8765 即可。访问 `/?local` 或直接双击 `index.html` 进入同屏练习（直接打开文件时使用 200 部热门作品的备用牌池）。修改端口：`npm start -- --port 3000`。

## 部署

首次部署先运行 `npx wrangler login`，之后 `npm run deploy` 即可发布到 `*.workers.dev`，需要时再绑定自定义域名。

- 房间保存在 Durable Object 的存储中，重新部署不会清空房间；无人操作两小时后自动清理。
- 实时同步使用 WebSocket（`/api/room/<房间号>/ws`），workers.dev 无需额外设置。
- 同一浏览器的多个标签页属于同一名玩家。掉线一分钟内重连，其他人不会看到你离线。
- 牌组由房主的浏览器按牌池抽取，服务端不加载 `anime_list.json`。
- 没有账号系统，也没有房间数量或请求频率限制，任何拿到地址的人都可以创建和加入房间。

## 数据

`anime_list.json` 来自 [bangumi-master](https://github.com/logicolors/bangumi-master) 每周抓取的 Bangumi 数据，`fallback-data.js` 是从中生成的 200 部备用数据和抓取日期。两者都不进 git：构建时若本地没有就自动下载。默认牌池：至少 1,000 人评分，排除国产、剧场版、OVA、泡面番、欧美、短片、总集篇，约 1,870 部。封面从远程图床加载，失败时显示占位图。

`npm run data:update` 手动拉取最新数据。线上由 Cloudflare Workers Builds 在每次推送 `main` 时构建部署（部署命令 `npm run deploy`，构建命令留空），每次构建都会下载最新数据。bangumi-master 每周抓取并提交新数据后，会调用本项目的 Deploy Hook 触发一次重新构建（bangumi-master 仓库 Secrets 中的 `ANICODE_DEPLOY_HOOK_URL`）。

## 文件与测试

- `worker/index.mjs`、`worker/room.mjs`：Worker 入口与房间 Durable Object。
- `room-core.js`：房间规则（权限、座位、投票、在线状态、回合限时），Worker 与单元测试共用。
- `multiplayer.js`：大厅、网络同步和身份恢复。
- `game.js`：共用的游戏规则和牌池筛选。
- `app.js`、`index.html`、`styles.css`：牌面、详情、筛选及同屏交互。
- `entry.js`、`demo.js`：首页背景牌阵和玩法演示。
- `scripts/build-assets.cjs`：把要发布的文件复制到 `dist/`，wrangler 启动和部署时自动运行。
- `server.cjs`：旧的 Node 服务（`npm run start:legacy`），已停止维护，不支持新的联机协议。

开发时运行 `npm ci` 安装全部依赖，然后：

- `npm test`：游戏规则和房间规则单元测试。
- `npm run test:multiplayer`、`npm run test:filters`、`npm run test:browser`：Playwright 浏览器测试（需安装 Microsoft Edge），各自在临时端口启动 `wrangler dev`。
