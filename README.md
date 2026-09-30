# sologsb-1121 森林样地调查记录台（gbforestplot）

面向森林资源调查员的固定样地工作台：为样地建档，逐株记录胸径、树高、枝下高与检尺位置，登记更新幼苗与灌木层，并在复查期与上一期数据逐株比对生长量、计算林分因子。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21821**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 断网作业包与三方合并（山上断网 → 回站合并）

调查组在山上无网，可在多台电脑上各自记录；回站后通过 **/sync「断网合并中心」** 交换 JSON 作业包完成合并。

1. **出队**：站端导出「外业基线作业包（base）」，本机同时记住该基线作为共同祖先。
2. **外业**：外业电脑导入基线包开工（只记住共同祖先、不动本机数据），在本台账照常录入/修改样木与更新苗灌木；收工导出「外业完成作业包（submit）」，完成包内嵌出队基线快照。
3. **回站预检**：导入完成包，系统按 `本地 / 基线 / 作业包` 三方版本逐实体判定：
   - **不同样地**（本地没有的新样地/样木/更新记录）→ 直接并入；
   - 仅外业一边改 → 采用外业；仅站端一边改 → 保留站端；两边一致 → 保留；
   - **同一株样木或同一条更新记录两边都改过** → 标记「两边都改」并排列出字段差异，逐行选择保留站端原档或采用外业；**确认前站端原档不被改动**。
4. **确认提交**：单事务原子写入——任何一步失败整体回滚、原档完整保留，预检计划保留可重试。

相关保证：

- **失效重算**：复查比对保存时盖内容指纹（含样地面积、复查期次与相关样木量测值）。样地面积/复查期次或样木变化、以及合并带入这些变化后，过期比对自动移入 `staleRechecks` 待重算，林分汇总始终按最新数据实时重算。
- **容量闸门**：作业包超过单包体积上限或本机剩余存储配额不足时，直接拒绝导入、零写入、完整保留原档。
- **幂等**：每个包有与内容绑定的 `packId`，记入 `importLedger`；同一作业包重复导入自动识别，不重复计数、不重复写入。
- **单一数据源**：合并结果、复查重算与林分汇总导出（txt）读取合并后的同一份 IndexedDB 数据。
- 无共同祖先（完成包未带基线）时采取保守策略：同 id 两边不同按冲突处理，绝不静默覆盖。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
npm run test:merge   # 断网合并/失效/幂等/容量/回滚 端到端冒烟（内存 IndexedDB）
npm run test:render  # 合并中心等页面的渲染冒烟
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1121/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── router/index.tsx
        ├── types/{plot,tree,regen,recheck,sync}.ts
        ├── stores/{plot,tree,regen}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag}.tsx
        ├── components/sync/EntityCompare.tsx
        ├── hooks/{usePlotFilter,useTreeStats}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary,SyncCenter}.tsx
        └── utils/{db,forestCalc,id,hash,package,merge}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期 | Plot |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示 | TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计 | RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存比对结果 | RecheckDiff、TreeRecord |
| `/summary/:plotId` | 林分因子汇总：每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | Plot、TreeRecord、RegenShrub |
| `/sync` | 断网作业包：导出基线/完成包，回站预检、三方合并、冲突并排取舍与导入台账 | 全部四张业务表 |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 六张表：`plots`（样地）、`trees`（样木，按期次分行）、`regens`（更新苗与灌木样方）、`rechecks`（复查逐株比对，含内容指纹 `contentRev`）、`importLedger`（作业包导入台账，按 `packId` 幂等去重）、`staleRechecks`（失效待重算的比对结果）。
- v1 → v2 迁移：为老样地补 `locked`、`surveyRound`，为老样木补 `round`、`measuredAt`，并新增索引。
- v2 → v3 迁移：新增 `importLedger`、`staleRechecks` 两表（老数据保留，无内容指纹的旧比对不主动失效）。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地、11 条样木（含第 1/2 两期，便于直接做复查比对）与 4 条样方记录。

## 功能要点

- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。保存时盖面积/期次/样木内容指纹，相关改动后自动失效待重算。
- **断网合并**：基线包/完成包三方合并，不同样地直并、两边都改并排取舍、确认前留原档；容量不足拒绝导入、失败事务回滚可重试、按包内容幂等去重。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt，导出读取合并后的同一份数据。
