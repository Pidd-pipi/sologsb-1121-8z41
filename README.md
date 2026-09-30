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

## 作业包合并（野外断网记录）

调查组在山上断网记录，回站后通过**作业包**与本站档案合并：

- **导出作业包**：台账页「导出作业包」将本站样地、样木、更新苗与灌木、复查比对结果打包为 JSON，供野外设备使用。
- **导入合并**：台账页「导入作业包」（`/import`）选择或粘贴作业包后自动解析并生成合并计划。
- **不同样地直接并入**：样地号不存在的样地及其样木、更新记录、比对结果整体并入，样木/更新记录换发本站 id。
- **两边都改并排确认**：同一株样木（样地 + 树号 + 期次）或同一条更新记录（样地 + 层位 + 种类 + 期次）两边不一致时，字段级并排展示「原档 / 新档」，默认**保留原档**，逐处确认后才覆盖。
- **失效重算**：样地面积或复查期次改动后，该样地已保存的复查比对作废清除；样木新增或冲突采用新档后，涉及期次的比对同步失效，需回复查比对页重新生成；林分汇总由各页从合并后数据实时重算。
- **失败回滚 + 重试**：合并在一个 Dexie 事务内提交，任何失败都回滚到合并前的完整原档，页面保留合并计划可直接重试。
- **容量不足拒绝导入**：写入超出浏览器本地存储配额时拒绝导入并保留完整原档，提示清理空间后重试。
- **重复导入不重复计数**：按作业包编号与业务数据内容哈希双重识别，已导入过的作业包再次导入时拦截，不重复并入。
- **同一份数据**：合并完成后各页面与导出读取的都是合并后的同一份档案数据。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
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
        ├── types/{plot,tree,regen,recheck}.ts
        ├── stores/{plot,tree,regen}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag}.tsx
        ├── hooks/{usePlotFilter,useTreeStats}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary}.tsx
        └── utils/{db,forestCalc,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期 | Plot |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示 | TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计 | RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存比对结果 | RecheckDiff、TreeRecord |
| `/summary/:plotId` | 林分因子汇总：每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | Plot、TreeRecord、RegenShrub |
| `/import` | 作业包导入与合并：解析作业包、并入新样地、冲突并排确认、失效比对清除、失败回滚重试、重复导入识别 | Plot、TreeRecord、RegenShrub、RecheckDiff、ImportRecord |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 五张表：`plots`（样地）、`trees`（样木，按期次分行）、`regens`（更新苗与灌木样方）、`rechecks`（复查逐株比对）、`imports`（作业包导入档案，用于重复导入识别）。
- v1 → v2 迁移：为老样地补 `locked`、`surveyRound`，为老样木补 `round`、`measuredAt`，并新增索引。
- v2 → v3 迁移：新增 `imports` 表。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地、11 条样木（含第 1/2 两期，便于直接做复查比对）与 4 条样方记录。

## 功能要点

- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt。
