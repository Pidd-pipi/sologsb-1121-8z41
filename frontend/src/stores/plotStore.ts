import { create } from 'zustand';
import { db, invalidateRechecks } from '../utils/db';
import { newId } from '../utils/id';
import type { Plot, PlotDraft } from '../types/plot';

interface PlotState {
  items: Plot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PlotDraft) => Promise<Plot>;
  update: (id: string, patch: Partial<Plot>) => Promise<void>;
  toggleLock: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const usePlotStore = create<PlotState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.plots.orderBy('createdAt').reverse().toArray();
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const record: Plot = { ...draft, id: newId('plot'), createdAt: Date.now() };
    await db.plots.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch) {
    // 样地面积或复查期次改动后，相关复查比对结果必须失效重算
    const before = get().items.find((it) => it.id === id);
    const areaChanged = patch.area !== undefined && before && patch.area !== before.area;
    const roundChanged = patch.surveyRound !== undefined && before && patch.surveyRound !== before.surveyRound;
    await db.plots.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    if (areaChanged || roundChanged) {
      await invalidateRechecks(
        id,
        areaChanged
          ? '样地面积已修改，依赖面积的比对与林分汇总失效，待重新生成'
          : '样地复查期次已修改，历史比对结果失效，待重新生成',
      );
    }
  },
  async toggleLock(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    await get().update(id, { locked: !target.locked });
  },
  async remove(id) {
    await db.plots.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
