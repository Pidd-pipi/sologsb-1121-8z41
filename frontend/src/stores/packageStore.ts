import { create } from 'zustand';
import { db } from '../utils/db';
import type { ImportRecord } from '../types/jobPackage';

interface PackageState {
  items: ImportRecord[];
  loaded: boolean;
  load: () => Promise<void>;
}

/** 作业包导入档案记录（用于重复导入识别与历史） */
export const usePackageStore = create<PackageState>((set) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.imports.orderBy('importedAt').reverse().toArray();
    set({ items: rows, loaded: true });
  },
}));
