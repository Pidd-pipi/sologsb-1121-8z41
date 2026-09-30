// @ts-nocheck
import { JSDOM } from 'jsdom';

async function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  (globalThis as any).window = w;
  (globalThis as any).document = w.document;
  (globalThis as any).navigator = w.navigator;
  for (const k of [
    'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'getComputedStyle',
    'DocumentFragment', 'ShadowRoot', 'HTMLInputElement', 'HTMLTextAreaElement',
    'FileReader', 'Blob', 'URL', 'File', 'DOMException', 'MouseEvent', 'SVGElement',
    'SVGGraphicsElement', 'SVGSVGElement', 'getSelection', 'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    if ((w as any)[k] && !(globalThis as any)[k]) (globalThis as any)[k] = (w as any)[k];
  }
  w.matchMedia =
    w.matchMedia ||
    function () {
      return {
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      };
    };
  if (!(w as any).ResizeObserver) {
    (w as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  return w;
}

async function main() {
  const w = await setupDom();
  await import('fake-indexeddb/auto');
  // fake-indexeddb 挂到了 jsdom window 上，而 Dexie 读取 globalThis，需要复制过去
  (globalThis as any).indexedDB = (w as any).indexedDB;
  (globalThis as any).IDBKeyRange = (w as any).IDBKeyRange;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react-dom/test-utils');
  const { MemoryRouter } = await import('react-router-dom');
  const { default: ImportPackage } = await import('../src/pages/ImportPackage');
  const { db, ensureSeedData } = await import('../src/utils/db');
  const { usePlotStore } = await import('../src/stores/plotStore');
  const { useTreeStore } = await import('../src/stores/treeStore');
  const { useRegenStore } = await import('../src/stores/regenStore');

  let failures = 0;
  function check(name: string, cond: boolean, extra = '') {
    if (cond) console.log(`  PASS ${name}`);
    else {
      failures += 1;
      console.error(`  FAIL ${name} ${extra}`);
    }
  }

  async function click(sel: string) {
    const el = document.querySelector(sel) as HTMLElement;
    if (!el) throw new Error(`找不到元素 ${sel}`);
    await act(async () => {
      el.click();
    });
  }

  async function waitFor(sel: string, timeout = 3000): Promise<HTMLElement> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(sel);
      if (el) return el as HTMLElement;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待元素超时: ${sel}`);
  }

  await ensureSeedData();
  await Promise.all([
    usePlotStore.getState().load(),
    useTreeStore.getState().load(),
    useRegenStore.getState().load(),
  ]);

  const container = document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ImportPackage),
      ),
    );
  });

  check('页面渲染：作业包导入页', !!document.querySelector('[data-testid=import-package-page]'));
  check('页面渲染：文件选择框', !!document.querySelector('[data-testid=package-file-input]'));
  check('页面渲染：导出作业包按钮', !!document.querySelector('[data-testid=export-package-btn]'));
  check('页面渲染：导入历史表', !!document.querySelector('[data-testid=import-history-table]'));
  check('初始无合并计划', !document.querySelector('[data-testid=merge-plan]'));

  // 构造一个与示范数据合并的作业包：新样地 + 冲突样木 + 冲突更新 + 新比对
  const plots = await db.plots.toArray();
  const trees = await db.trees.toArray();
  const regens = await db.regens.toArray();
  const seedPlot = plots[0];

  const pkg = {
    meta: { packageId: 'pkg_e2e_001', source: '野外调查三组', exportedAt: Date.now(), version: 1 },
    plots: [
      // 同号样地：面积 600 → 680（触发失效重算）
      { ...seedPlot, area: 680 },
      // 新样地直接并入
      {
        id: 'field_new_plot',
        plotNo: 'FP-FIELD-01',
        locality: '野外新增样地',
        lng: 128.9, lat: 47.2, shape: '方形', area: 500, elevation: 400, slope: 6, aspect: '东',
        forestType: '针阔混交林', canopyDensity: 0.6, dominantSpecies: '红松', surveyRound: 1,
        surveyedAt: Date.now(), crew: '野外三组', locked: false, createdAt: Date.now(),
      },
    ],
    trees: [
      // 冲突：样地1 树号1 第1期 胸径被野外改测
      { ...trees[0], dbhCm: trees[0].dbhCm + 3.5, measuredAt: Date.now() },
      // 新样地新样木
      {
        id: 'field_new_tree', plotId: 'field_new_plot', treeNo: '1', species: '红松',
        dbhCm: 18, heightM: 12, underBranchH: 4, crownWidth: 3, status: '活立木',
        origin: '天然', healthClass: '健康', tiltDeg: 0, remark: '', round: 1, measuredAt: Date.now(),
      },
    ],
    regens: [
      // 冲突：更新苗红松 株数被野外改测
      { ...regens[0], count: regens[0].count + 7 },
    ],
    rechecks: [
      // 新样地的新比对
      {
        id: 'field_new_diff', plotId: 'field_new_plot', baseRound: 0, targetRound: 1, treeNo: '1',
        species: '红松', dbhGrowth: 0, heightGrowth: 0, statusChange: '',
        missingReason: '本期新增进界木', generatedAt: Date.now(),
      },
    ],
  };

  const textarea = document.querySelector('[data-testid=package-paste-area]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, JSON.stringify(pkg));
    textarea.dispatchEvent(new w.Event('input', { bubbles: true }));
  });

  await click('[data-testid=parse-package-btn]');

  await waitFor('[data-testid=merge-plan]');
  check('解析后出现合并计划', !!document.querySelector('[data-testid=merge-plan]'));
  check('识别样木冲突', document.body.textContent?.includes('样木冲突 1 处'));
  check('识别更新冲突', document.body.textContent?.includes('更新记录冲突 1 处'));
  check('出现冲突并排确认区', !!document.querySelector('[data-testid=conflict-section]'));
  check('冲突默认保留原档', document.body.textContent?.includes('保留原档'));
  check('出现失效重算提示', !!document.querySelector('[data-testid=invalidation-alert]'));
  check('出现确认合并按钮', !!document.querySelector('[data-testid=apply-merge-btn]'));

  // 每组冲突默认保留原档（直接确认合并）
  const radios = document.querySelectorAll('[data-testid=resolution-radio] input[type=radio]');
  check('有两组冲突单选项（4 个 radio）', radios.length === 4, `got ${radios.length}`);

  await click('[data-testid=apply-merge-btn]');

  await waitFor('[data-testid=merge-success-alert]');
  check('合并成功提示出现', !!document.querySelector('[data-testid=merge-success-alert]'));
  check('计划区消失', !document.querySelector('[data-testid=merge-plan]'));

  // 验证合并后数据
  const plotsAfter = await db.plots.toArray();
  const treesAfter = await db.trees.toArray();
  const rechecksAfter = await db.rechecks.toArray();
  const importsAfter = await db.imports.toArray();
  check('新样地已并入', plotsAfter.some((p) => p.plotNo === 'FP-FIELD-01'));
  check('样地面积已更新为 680', plotsAfter.find((p) => p.plotNo === seedPlot.plotNo)?.area === 680);
  check('冲突样木保留原档（胸径未变）', treesAfter.some((t) => t.id === trees[0].id && t.dbhCm === trees[0].dbhCm));
  check('新样地样木已并入', treesAfter.some((t) => t.plotId === plotsAfter.find((p) => p.plotNo === 'FP-FIELD-01')?.id && t.treeNo === '1'));
  check('新样地比对已并入', rechecksAfter.some((d) => d.treeNo === '1' && d.missingReason === '本期新增进界木'));
  check('导入历史已建档', importsAfter.some((i) => i.packageId === 'pkg_e2e_001'));

  // 重复导入：再次解析同一作业包
  await act(async () => {
    setter.call(textarea, JSON.stringify(pkg));
    textarea.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  await click('[data-testid=parse-package-btn]');
  await waitFor('[data-testid=duplicate-alert]');
  check('重复导入提示出现', !!document.querySelector('[data-testid=duplicate-alert]'));
  const applyBtn = document.querySelector('[data-testid=apply-merge-btn]') as HTMLButtonElement;
  check('重复导入时确认按钮禁用', applyBtn.disabled);

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
