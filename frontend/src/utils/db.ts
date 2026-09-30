import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import type { PackageKind } from '../types/sync';
import { recheckRev } from '../types/sync';
import { newId } from './id';

export const DB_NAME = 'gbforestplot';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbforestplot:db-version';
export const LS_STATION_KEY = 'gbforestplot:station';

/** 已导入作业包台账（按包内容哈希去重，保证重复导入不重复计数） */
export interface ImportLedgerEntry {
  packId: string;
  kind: PackageKind;
  station: string;
  importedAt: number;
  added: number;
  updated: number;
  skipped: number;
}

/** 已失效、待重算的复查比对结果（样地面积/期次或样木量测变化后写入） */
export interface StaleRecheck {
  /** 即原 recheck 行 id */
  id: string;
  plotId: string;
  baseRound: number;
  targetRound: number;
  treeNo: string;
  invalidatedAt: number;
  reason: string;
}

class ForestPlotDB extends Dexie {
  plots!: Table<Plot, string>;
  trees!: Table<TreeRecord, string>;
  regens!: Table<RegenShrub, string>;
  rechecks!: Table<RecheckDiff, string>;
  importLedger!: Table<ImportLedgerEntry, string>;
  staleRechecks!: Table<StaleRecheck, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, createdAt',
      trees: 'id, plotId, treeNo, species, round, status',
      regens: 'id, plotId, layer, species, round',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo',
    });
    this.version(2)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('plots')
          .toCollection()
          .modify((row: any) => {
            if (row.locked === undefined) row.locked = false;
            if (row.surveyRound === undefined) row.surveyRound = 1;
          });
        await tx
          .table('trees')
          .toCollection()
          .modify((row: any) => {
            if (row.round === undefined) row.round = 1;
            if (row.measuredAt === undefined) row.measuredAt = Date.now();
          });
      });
    // v3：断网作业包合并——导入台账（幂等）+ 失效复查结果登记表
    this.version(3).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
      trees: 'id, plotId, treeNo, species, round, status, measuredAt',
      regens: 'id, plotId, layer, species, round, heightCm',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
      importLedger: 'packId, importedAt',
      staleRechecks: 'id, plotId, baseRound, targetRound, invalidatedAt',
    });
  }
}

export const db = new ForestPlotDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export async function saveRecheckDiffs(diffs: RecheckDiff[]): Promise<void> {
  await db.rechecks.bulkPut(diffs);
}

export async function loadRecheckDiffs(plotId: string): Promise<RecheckDiff[]> {
  const rows = await db.rechecks.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.treeNo.localeCompare(b.treeNo));
}

/** 站端标识：同一浏览器稳定，用于作业包来源展示 */
export function getStationId(): string {
  try {
    let id = window.localStorage.getItem(LS_STATION_KEY);
    if (!id) {
      id = `station-${Math.random().toString(36).slice(2, 8)}`;
      window.localStorage.setItem(LS_STATION_KEY, id);
    }
    return id;
  } catch {
    return 'station-unknown';
  }
}

/* ---------------- 导入台账（幂等） ---------------- */

export async function hasImport(packId: string): Promise<boolean> {
  return (await db.importLedger.get(packId)) !== undefined;
}

export async function recordImport(entry: ImportLedgerEntry): Promise<void> {
  await db.importLedger.put(entry);
}

export async function listImports(): Promise<ImportLedgerEntry[]> {
  return db.importLedger.orderBy('importedAt').reverse().toArray();
}

/* ---------------- 失效复查结果登记 ---------------- */

/**
 * 将某样地（可缩窄到指定期次对）的已保存比对结果移入 staleRechecks 并从档案库删除。
 * 触发时机：样地面积 / 复查期次改动，或相关样木量测值变化，或合并带入这些变化。
 * 返回失效的条数。
 */
export async function invalidateRechecks(
  plotId: string,
  reason: string,
  rounds?: { baseRound: number; targetRound: number },
): Promise<number> {
  const now = Date.now();
  let moved = 0;
  await db.transaction('rw', db.rechecks, db.staleRechecks, async () => {
    let rows = await db.rechecks.where('plotId').equals(plotId).toArray();
    if (rounds) {
      rows = rows.filter(
        (r) => r.baseRound === rounds.baseRound && r.targetRound === rounds.targetRound,
      );
    }
    if (rows.length === 0) return;
    moved = rows.length;
    await db.staleRechecks.bulkPut(
      rows.map((r) => ({
        id: r.id,
        plotId: r.plotId,
        baseRound: r.baseRound,
        targetRound: r.targetRound,
        treeNo: r.treeNo,
        invalidatedAt: now,
        reason,
      })),
    );
    await db.rechecks.bulkDelete(rows.map((r) => r.id));
  });
  return moved;
}

export async function loadStaleRechecks(plotId: string): Promise<StaleRecheck[]> {
  return db.staleRechecks.where('plotId').equals(plotId).reverse().sortBy('invalidatedAt');
}

/**
 * 按内容指纹复核某样地已保存的比对结果：凡是保存时版本（contentRev）
 * 与当前样地面积/期次、相关样木量测重算不一致的，移入 staleRechecks 待重算。
 * 没有 contentRev 的旧档案（v3 升级前）不主动失效。
 * 用于样木量测改动与作业包合并后，只让真正过期的比对/汇总失效。
 */
export async function revalidatePlotRechecks(plotId: string, reason: string): Promise<number> {
  const [plot, rows, trees] = await Promise.all([
    db.plots.get(plotId),
    db.rechecks.where('plotId').equals(plotId).toArray(),
    db.trees.where('plotId').equals(plotId).toArray(),
  ]);
  if (!plot || rows.length === 0) return 0;
  const now = Date.now();
  const stale: StaleRecheck[] = [];
  rows.forEach((r) => {
    if (r.contentRev && r.contentRev !== recheckRev(r, plot, trees)) {
      stale.push({
        id: r.id,
        plotId: r.plotId,
        baseRound: r.baseRound,
        targetRound: r.targetRound,
        treeNo: r.treeNo,
        invalidatedAt: now,
        reason,
      });
    }
  });
  if (stale.length === 0) return 0;
  await db.transaction('rw', db.rechecks, db.staleRechecks, async () => {
    await db.staleRechecks.bulkPut(stale);
    await db.rechecks.bulkDelete(stale.map((s) => s.id));
  });
  return stale.length;
}

/** 重新生成并保存某期次对的比对结果后，清除对应的失效登记 */
export async function clearStaleRechecks(
  plotId: string,
  baseRound: number,
  targetRound: number,
): Promise<void> {
  const rows = await db.staleRechecks.where('plotId').equals(plotId).toArray();
  const ids = rows
    .filter((r) => r.baseRound === baseRound && r.targetRound === targetRound)
    .map((r) => r.id);
  if (ids.length > 0) await db.staleRechecks.bulkDelete(ids);
}

/** 首次进入灌入示范样地与两期样木数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.plots.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const plotId = newId('plot');
  const plot2Id = newId('plot');

  const plots: Plot[] = [
    {
      id: plotId,
      plotNo: 'FP-4102',
      locality: '黑龙江凉水林场 12 林班',
      lng: 128.8934,
      lat: 47.1832,
      shape: '方形',
      area: 600,
      elevation: 412,
      slope: 8,
      aspect: '东南',
      forestType: '针阔混交林',
      canopyDensity: 0.72,
      dominantSpecies: '红松 + 紫椴',
      surveyRound: 2,
      surveyedAt: now - 6 * day,
      crew: '调查一组（顾青、李慕）',
      locked: true,
      createdAt: now - 400 * day,
    },
    {
      id: plot2Id,
      plotNo: 'FP-4115',
      locality: '黑龙江凉水林场 15 林班',
      lng: 128.9012,
      lat: 47.1901,
      shape: '圆形',
      area: 500,
      elevation: 388,
      slope: 14,
      aspect: '西南',
      forestType: '阔叶林',
      canopyDensity: 0.65,
      dominantSpecies: '蒙古栎',
      surveyRound: 1,
      surveyedAt: now - 3 * day,
      crew: '调查二组（周砚）',
      locked: false,
      createdAt: now - 120 * day,
    },
  ];

  type Seed = [string, string, number, number, number, number, TreeRecord['status']];
  const seeds: Seed[] = [
    ['1', '红松', 34.2, 18.6, 7.4, 5.2, '活立木'],
    ['2', '紫椴', 26.8, 15.2, 5.1, 4.4, '活立木'],
    ['3', '红松', 41.5, 21.3, 9.2, 6.1, '活立木'],
    ['4', '蒙古栎', 18.4, 11.5, 3.6, 3.2, '活立木'],
    ['5', '色木槭', 12.6, 9.4, 2.8, 2.6, '活立木'],
  ];

  const trees: TreeRecord[] = [];
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw, status]) => {
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: dbh,
      heightM: h,
      underBranchH: ubh,
      crownWidth: cw,
      status,
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 1,
      measuredAt: now - 370 * day,
    });
  });
  // 第 2 期：树号 1/2/3/5 复测（胸径增大），树号 4 被采伐 → 复查比对可标记缺失
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw], index) => {
    if (treeNo === '4') return;
    const growth = [1.8, 1.4, 2.2, 0.9][index > 3 ? 3 : index];
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: Math.round((dbh + growth) * 10) / 10,
      heightM: Math.round((h + growth * 0.6) * 10) / 10,
      underBranchH: ubh,
      crownWidth: cw,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 2,
      measuredAt: now - 6 * day,
    });
  });
  // 第 2 期新增进界木
  trees.push({
    id: newId('tree'),
    plotId,
    treeNo: '6',
    species: '色木槭',
    dbhCm: 6.2,
    heightM: 6.1,
    underBranchH: 1.8,
    crownWidth: 1.9,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 1,
    remark: '样地东南 3m 进界木',
    round: 2,
    measuredAt: now - 6 * day,
  });
  trees.push({
    id: newId('tree'),
    plotId: plot2Id,
    treeNo: '1',
    species: '蒙古栎',
    dbhCm: 22.4,
    heightM: 13.2,
    underBranchH: 4.2,
    crownWidth: 4.1,
    status: '活立木',
    origin: '天然',
    healthClass: '亚健康',
    tiltDeg: 6,
    remark: '样地西侧',
    round: 1,
    measuredAt: now - 3 * day,
  });

  const regens: RegenShrub[] = [
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '红松',
      heightCm: 32,
      count: 18,
      ageGroup: '3 年生',
      distribution: '团状',
      browseDamage: '轻度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '紫椴',
      heightCm: 55,
      count: 9,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '灌木',
      species: '毛榛子',
      heightCm: 120,
      count: 26,
      ageGroup: '多年生',
      distribution: '团状',
      browseDamage: '中度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '草本',
      species: '苔草',
      heightCm: 22,
      count: 140,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
  ];

  await db.transaction('rw', db.plots, db.trees, db.regens, db.rechecks, async () => {
    await db.plots.bulkPut(plots);
    await db.trees.bulkPut(trees);
    await db.regens.bulkPut(regens);
  });
}
