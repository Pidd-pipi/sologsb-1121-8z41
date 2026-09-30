import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { db, ensureSeedData } from '../src/utils/db';
import { usePlotStore } from '../src/stores/plotStore';
import { useTreeStore } from '../src/stores/treeStore';
import { useRegenStore } from '../src/stores/regenStore';
import SyncCenter from '../src/pages/SyncCenter';
import RecheckView from '../src/pages/RecheckView';

class LocalStorageShim {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
(globalThis as unknown as { window: unknown }).window = { localStorage: new LocalStorageShim() };
(globalThis as unknown as { navigator: unknown }).navigator = {
  storage: { estimate: async () => ({ quota: 1e12, usage: 0 }) },
};
(globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

async function main() {
  await ensureSeedData();
  await Promise.all([usePlotStore.getState().load(), useTreeStore.getState().load(), useRegenStore.getState().load()]);

  const html1 = renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: ['/sync'] }, React.createElement(SyncCenter)),
  );
  if (!html1.includes('断网作业包') || !html1.includes('导出外业基线作业包')) {
    throw new Error('SyncCenter 关键文案缺失');
  }
  console.log('✓ SyncCenter 渲染成功，含导出/合并入口；HTML 长度', html1.length);

  const firstPlot = usePlotStore.getState().items[0];
  // RecheckView 依赖 useParams，SSR 下首帧 plot 未解析也会稳定渲染（提示态）；
  // 这里验证组件树本身不抛错即可
  const html2 = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/plots/${firstPlot.id}/recheck`] },
      React.createElement(RecheckView),
    ),
  );
  if (html2.length < 100) throw new Error('RecheckView 未正常产出');
  console.log('✓ RecheckView 组件树渲染通过，长度', html2.length);

  console.log('渲染冒烟通过；库内样地数', await db.plots.count());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
