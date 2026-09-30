import { db } from './db';
import { newId } from './id';
import { hashPackage } from './packageHash';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import { REGEN_LAYERS } from '../types/regen';
import { JOB_PACKAGE_VERSION, type ImportRecord, type JobPackage } from '../types/jobPackage';

/* ============================== 解析 ============================== */

export type ParseResult = { ok: true; pkg: JobPackage } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 校验作业包 JSON 的形状与必填字段，返回中文错误说明 */
export function parsePackage(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，请确认是从本站导出的作业包文件' };
  }
  if (!isObject(data)) return { ok: false, error: '作业包内容格式不正确（顶层应为对象）' };
  const meta = data.meta;
  if (!isObject(meta)) return { ok: false, error: '作业包缺少 meta 元信息' };
  if (!str(meta.packageId)) return { ok: false, error: '作业包缺少 meta.packageId（作业包编号）' };
  if (meta.version !== JOB_PACKAGE_VERSION) {
    return { ok: false, error: `作业包版本不支持（仅支持 v${JOB_PACKAGE_VERSION}）` };
  }
  if (!Array.isArray(data.plots) || !Array.isArray(data.trees) || !Array.isArray(data.regens) || !Array.isArray(data.rechecks)) {
    return { ok: false, error: '作业包缺少 plots / trees / regens / rechecks 数据数组' };
  }

  for (const [i, p] of (data.plots as unknown[]).entries()) {
    if (!isObject(p)) return { ok: false, error: `第 ${i + 1} 条样地记录格式不正确` };
    if (!str(p.id) || !str(p.plotNo)) return { ok: false, error: `第 ${i + 1} 条样地缺少 id 或样地号` };
    if (typeof p.area !== 'number' || p.area <= 0) return { ok: false, error: `样地「${String(p.plotNo)}」面积无效` };
    if (typeof p.surveyRound !== 'number' || p.surveyRound < 1) {
      return { ok: false, error: `样地「${String(p.plotNo)}」复查期次无效` };
    }
  }
  for (const [i, t] of (data.trees as unknown[]).entries()) {
    if (!isObject(t)) return { ok: false, error: `第 ${i + 1} 条样木记录格式不正确` };
    if (!str(t.id) || !str(t.plotId) || !str(t.treeNo)) {
      return { ok: false, error: `第 ${i + 1} 条样木缺少 id / plotId / 树号` };
    }
    if (typeof t.round !== 'number' || t.round < 1) return { ok: false, error: `样木「${String(t.treeNo)}」期次无效` };
  }
  for (const [i, r] of (data.regens as unknown[]).entries()) {
    if (!isObject(r)) return { ok: false, error: `第 ${i + 1} 条更新记录格式不正确` };
    if (!str(r.id) || !str(r.plotId) || !str(r.species)) {
      return { ok: false, error: `第 ${i + 1} 条更新记录缺少 id / plotId / 种类` };
    }
    if (!REGEN_LAYERS.includes(r.layer as RegenShrub['layer'])) {
      return { ok: false, error: `更新记录「${String(r.species)}」层位无效` };
    }
    if (typeof r.round !== 'number' || r.round < 1) return { ok: false, error: `更新记录「${String(r.species)}」期次无效` };
  }
  for (const [i, d] of (data.rechecks as unknown[]).entries()) {
    if (!isObject(d)) return { ok: false, error: `第 ${i + 1} 条复查比对记录格式不正确` };
    if (!str(d.id) || !str(d.plotId) || !str(d.treeNo)) {
      return { ok: false, error: `第 ${i + 1} 条复查比对缺少 id / plotId / 树号` };
    }
    if (typeof d.baseRound !== 'number' || typeof d.targetRound !== 'number') {
      return { ok: false, error: `复查比对「${String(d.treeNo)}」期次无效` };
    }
  }
  return { ok: true, pkg: data as unknown as JobPackage };
}

/* ============================== 合并计划 ============================== */

export interface FieldDiff {
  key: string;
  label: string;
  local: string;
  incoming: string;
}

export interface TreeConflict {
  kind: 'tree';
  /** 冲突标识（含重映射后的样地 id） */
  key: string;
  plotId: string;
  plotNo: string;
  treeNo: string;
  round: number;
  local: TreeRecord;
  incoming: TreeRecord;
  fields: FieldDiff[];
}

export interface RegenConflict {
  kind: 'regen';
  key: string;
  plotId: string;
  plotNo: string;
  local: RegenShrub;
  incoming: RegenShrub;
  fields: FieldDiff[];
}

export interface PlotChange {
  local: Plot;
  incoming: Plot;
  changedFields: FieldDiff[];
  areaChanged: boolean;
  roundChanged: boolean;
}

export interface MergeCounts {
  plots: number;
  trees: number;
  regens: number;
  rechecks: number;
}

export interface MergePlan {
  /** 重复导入（作业包编号或内容哈希已存在） */
  duplicate: boolean;
  duplicateReason?: 'packageId' | 'contentHash';
  importedAt?: number;
  /** 直接并入的新样地（已换发本地 id） */
  plotInserts: Plot[];
  /** 同号样地的信息变更（面积/期次变更会触发比对失效） */
  plotChanges: PlotChange[];
  treeInserts: TreeRecord[];
  treeConflicts: TreeConflict[];
  regenInserts: RegenShrub[];
  regenConflicts: RegenConflict[];
  recheckInserts: RecheckDiff[];
  recheckSkipped: number;
  /** 找不到归属样地而跳过的记录数 */
  orphanTrees: number;
  orphanRegens: number;
  counts: MergeCounts;
}

export type Resolution = 'local' | 'incoming';

export type LocalSnapshot = {
  plots: Plot[];
  trees: TreeRecord[];
  regens: RegenShrub[];
  rechecks: RecheckDiff[];
};

const treeKey = (plotId: string, treeNo: string, round: number): string =>
  `${plotId}|${treeNo.trim()}|${round}`;
const regenKey = (plotId: string, layer: string, species: string, round: number): string =>
  `${plotId}|${layer}|${species.trim()}|${round}`;
const recheckKey = (plotId: string, baseRound: number, targetRound: number, treeNo: string): string =>
  `${plotId}|${baseRound}|${targetRound}|${treeNo.trim()}`;

function diffFields(
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  labels: Record<string, string>,
): FieldDiff[] {
  return Object.entries(labels)
    .filter(([k]) => JSON.stringify(local[k] ?? '') !== JSON.stringify(incoming[k] ?? ''))
    .map(([k, label]) => ({
      key: k,
      label,
      local: formatVal(local[k]),
      incoming: formatVal(incoming[k]),
    }));
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'number') return String(v);
  return String(v);
}

const TREE_FIELD_LABELS: Record<string, string> = {
  species: '树种',
  dbhCm: '胸径 cm',
  heightM: '树高 m',
  underBranchH: '枝下高 m',
  crownWidth: '冠幅 m',
  status: '状态',
  origin: '起源',
  healthClass: '健康等级',
  tiltDeg: '倾斜度 °',
  remark: '位置描述',
  measuredAt: '测量时间',
};

const REGEN_FIELD_LABELS: Record<string, string> = {
  layer: '层位',
  species: '种类',
  heightCm: '高度 cm',
  count: '株数',
  ageGroup: '苗龄组',
  distribution: '分布',
  browseDamage: '啃食情况',
  round: '期次',
};

const PLOT_FIELD_LABELS: Record<string, string> = {
  locality: '地点',
  lng: '经度',
  lat: '纬度',
  shape: '形状',
  area: '面积 m²',
  elevation: '海拔 m',
  slope: '坡度 °',
  aspect: '坡向',
  forestType: '林型',
  canopyDensity: '郁闭度',
  dominantSpecies: '优势树种',
  surveyRound: '复查期次',
  surveyedAt: '调查时间',
  crew: '调查组',
};

/**
 * 生成合并计划（纯函数）：
 * - 不同样地（样地号不存在）直接并入；
 * - 同样地号的样地信息变更列出，面积/期次变更触发比对失效；
 * - 同样木（样地+树号+期次）或同更新记录（样地+层位+种类+期次）两边不一致 → 冲突，并排确认；
 * - 复查比对按 样地+上期+本期+树号 去重，已存在则跳过。
 */
export function buildMergePlan(
  local: LocalSnapshot,
  pkg: JobPackage,
  imports: ImportRecord[],
  contentHash: string,
): MergePlan {
  const duplicateRecord = imports.find(
    (r) => r.packageId === pkg.meta.packageId || r.contentHash === contentHash,
  );

  // 样地号 → 本地样地；作业包样地 id → 本地样地 id
  const localByPlotNo = new Map<string, Plot>();
  local.plots.forEach((p) => localByPlotNo.set(p.plotNo.trim(), p));
  const idRemap = new Map<string, string>();

  const plotInserts: Plot[] = [];
  const plotChanges: PlotChange[] = [];

  pkg.plots.forEach((p) => {
    const existing = localByPlotNo.get(p.plotNo.trim());
    if (existing) {
      idRemap.set(p.id, existing.id);
      const changedFields = diffFields(
        existing as unknown as Record<string, unknown>,
        p as unknown as Record<string, unknown>,
        PLOT_FIELD_LABELS,
      );
      if (changedFields.length > 0) {
        plotChanges.push({
          local: existing,
          incoming: { ...p, id: existing.id },
          changedFields,
          areaChanged: changedFields.some((f) => f.key === 'area'),
          roundChanged: changedFields.some((f) => f.key === 'surveyRound'),
        });
      }
    } else {
      const localId = newId('plot');
      idRemap.set(p.id, localId);
      plotInserts.push({ ...p, id: localId });
    }
  });
  // 作业包可能由本站数据导出：样地 id 与本地 id 相同时直接映射
  local.plots.forEach((p) => {
    if (!idRemap.has(p.id)) idRemap.set(p.id, p.id);
  });

  const plotNoOf = (plotId: string): string => {
    const localPlot = local.plots.find((p) => p.id === plotId);
    if (localPlot) return localPlot.plotNo;
    const pkgPlot = pkg.plots.find((p) => idRemap.get(p.id) === plotId);
    return pkgPlot?.plotNo ?? '?';
  };

  // 样木
  const localTreeByKey = new Map<string, TreeRecord>();
  local.trees.forEach((t) => localTreeByKey.set(treeKey(t.plotId, t.treeNo, t.round), t));
  const treeInserts: TreeRecord[] = [];
  const treeConflicts: TreeConflict[] = [];
  let orphanTrees = 0;

  pkg.trees.forEach((t) => {
    const plotId = idRemap.get(t.plotId);
    if (!plotId) {
      orphanTrees += 1;
      return;
    }
    const incoming: TreeRecord = { ...t, plotId };
    const key = treeKey(plotId, t.treeNo, t.round);
    const existing = localTreeByKey.get(key);
    if (!existing) {
      treeInserts.push({ ...incoming, id: newId('tree') });
    } else {
      const fields = diffFields(
        existing as unknown as Record<string, unknown>,
        incoming as unknown as Record<string, unknown>,
        TREE_FIELD_LABELS,
      );
      if (fields.length > 0) {
        treeConflicts.push({
          kind: 'tree',
          key: `tree:${key}`,
          plotId,
          plotNo: plotNoOf(plotId),
          treeNo: t.treeNo.trim(),
          round: t.round,
          local: existing,
          incoming,
          fields,
        });
      }
    }
  });

  // 更新苗与灌木
  const localRegenByKey = new Map<string, RegenShrub>();
  local.regens.forEach((r) =>
    localRegenByKey.set(regenKey(r.plotId, r.layer, r.species, r.round), r),
  );
  const regenInserts: RegenShrub[] = [];
  const regenConflicts: RegenConflict[] = [];
  let orphanRegens = 0;

  pkg.regens.forEach((r) => {
    const plotId = idRemap.get(r.plotId);
    if (!plotId) {
      orphanRegens += 1;
      return;
    }
    const incoming: RegenShrub = { ...r, plotId };
    const key = regenKey(plotId, r.layer, r.species, r.round);
    const existing = localRegenByKey.get(key);
    if (!existing) {
      regenInserts.push({ ...incoming, id: newId('regen') });
    } else {
      const fields = diffFields(
        existing as unknown as Record<string, unknown>,
        incoming as unknown as Record<string, unknown>,
        REGEN_FIELD_LABELS,
      );
      if (fields.length > 0) {
        regenConflicts.push({
          kind: 'regen',
          key: `regen:${key}`,
          plotId,
          plotNo: plotNoOf(plotId),
          local: existing,
          incoming,
          fields,
        });
      }
    }
  });

  // 复查比对（按 样地+上期+本期+树号 去重）
  const localRecheckByKey = new Map<string, RecheckDiff>();
  local.rechecks.forEach((d) =>
    localRecheckByKey.set(recheckKey(d.plotId, d.baseRound, d.targetRound, d.treeNo), d),
  );
  const recheckInserts: RecheckDiff[] = [];
  let recheckSkipped = 0;

  pkg.rechecks.forEach((d) => {
    const plotId = idRemap.get(d.plotId);
    if (!plotId) {
      recheckSkipped += 1;
      return;
    }
    const key = recheckKey(plotId, d.baseRound, d.targetRound, d.treeNo);
    if (localRecheckByKey.has(key)) {
      recheckSkipped += 1;
    } else {
      recheckInserts.push({ ...d, plotId, id: newId('diff') });
    }
  });

  return {
    duplicate: !!duplicateRecord,
    duplicateReason: duplicateRecord
      ? duplicateRecord.packageId === pkg.meta.packageId
        ? 'packageId'
        : 'contentHash'
      : undefined,
    importedAt: duplicateRecord?.importedAt,
    plotInserts,
    plotChanges,
    treeInserts,
    treeConflicts,
    regenInserts,
    regenConflicts,
    recheckInserts,
    recheckSkipped,
    orphanTrees,
    orphanRegens,
    counts: {
      plots: plotInserts.length,
      trees: treeInserts.length,
      regens: regenInserts.length,
      rechecks: recheckInserts.length,
    },
  };
}

/* ============================== 失效重算 ============================== */

/**
 * 计算合并后需要作废删除的复查比对：
 * - 样地面积或复查期次变更 → 该样地全部比对失效；
 * - 样木有新增 / 冲突后采用新档 → 该样地涉及相应期次的比对失效。
 * 林分汇总由各页面从合并后的数据实时重算，无需落库。
 */
export function rechecksToDelete(
  localRechecks: RecheckDiff[],
  plan: MergePlan,
  resolutions: Record<string, Resolution>,
): RecheckDiff[] {
  const affected = new Map<string, { all: boolean; rounds: Set<number> }>();
  const markAll = (plotId: string) => {
    const cur = affected.get(plotId) ?? { all: false, rounds: new Set<number>() };
    cur.all = true;
    affected.set(plotId, cur);
  };
  const markRound = (plotId: string, round: number) => {
    const cur = affected.get(plotId) ?? { all: false, rounds: new Set<number>() };
    cur.rounds.add(round);
    affected.set(plotId, cur);
  };

  plan.plotChanges.forEach((c) => {
    if (c.areaChanged || c.roundChanged) markAll(c.local.id);
  });
  plan.treeInserts.forEach((t) => markRound(t.plotId, t.round));
  plan.treeConflicts.forEach((c) => {
    if (resolutions[c.key] === 'incoming') markRound(c.plotId, c.round);
  });

  return localRechecks.filter((d) => {
    const a = affected.get(d.plotId);
    if (!a) return false;
    return a.all || a.rounds.has(d.baseRound) || a.rounds.has(d.targetRound);
  });
}

/* ============================== 提交合并 ============================== */

export class MergeError extends Error {
  constructor(
    public kind: 'quota' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

export interface ApplyResult {
  inserted: MergeCounts;
  deletedRechecks: number;
}

/**
 * 事务性提交合并：全部写入在一个 Dexie 读写事务中完成，
 * 任何失败（含容量不足）都会回滚，原档完整保留；调用方据此可重试。
 */
export async function applyMerge(
  plan: MergePlan,
  resolutions: Record<string, Resolution>,
  pkg: JobPackage,
  contentHash: string,
  fileName: string,
): Promise<ApplyResult> {
  const toDelete = rechecksToDelete(
    await db.rechecks.toArray(),
    plan,
    resolutions,
  );

  try {
    await db.transaction(
      'rw',
      db.plots,
      db.trees,
      db.regens,
      db.rechecks,
      db.imports,
      async () => {
        await db.plots.bulkPut(plan.plotInserts);
        await db.plots.bulkPut(plan.plotChanges.map((c) => c.incoming));
        await db.trees.bulkPut(plan.treeInserts);
        await db.regens.bulkPut(plan.regenInserts);
        await db.rechecks.bulkPut(plan.recheckInserts);

        // 冲突处理：默认保留原档；采用新档时以本地 id 覆盖原记录
        const treeOverrides = plan.treeConflicts
          .filter((c) => resolutions[c.key] === 'incoming')
          .map((c) => ({ ...c.incoming, id: c.local.id }));
        const regenOverrides = plan.regenConflicts
          .filter((c) => resolutions[c.key] === 'incoming')
          .map((c) => ({ ...c.incoming, id: c.local.id }));
        if (treeOverrides.length > 0) await db.trees.bulkPut(treeOverrides);
        if (regenOverrides.length > 0) await db.regens.bulkPut(regenOverrides);

        if (toDelete.length > 0) {
          await db.rechecks.bulkDelete(toDelete.map((d) => d.id));
        }

        const record: ImportRecord = {
          packageId: pkg.meta.packageId,
          fileName,
          contentHash,
          importedAt: Date.now(),
          counts: {
            plots: plan.counts.plots + plan.plotChanges.length,
            trees: plan.counts.trees + treeOverrides.length,
            regens: plan.counts.regens + regenOverrides.length,
            rechecks: plan.counts.rechecks,
          },
        };
        await db.imports.put(record);
      },
    );
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    const message = (err as Error)?.message ?? '';
    const isQuota =
      name === 'QuotaExceededError' ||
      name === 'QuotaExceeded' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      /quota|存储空间|容量/i.test(message);
    if (isQuota) {
      throw new MergeError(
        'quota',
        '作业包容量不足（浏览器本地存储已满），已拒绝导入并保留完整原档。请清理站点数据或释放浏览器空间后重试。',
      );
    }
    throw new MergeError(
      'failed',
      `合并失败：${message || '未知错误'}。原数据已恢复为合并前状态，可修正后重试。`,
    );
  }

  return {
    inserted: { ...plan.counts },
    deletedRechecks: toDelete.length,
  };
}

/* ============================== 容量预估 ============================== */

export interface StorageInfo {
  usage: number;
  quota: number;
}

/** 读取浏览器本地存储配额（不支持时返回 null，由事务写入兜底） */
export async function storageInfo(): Promise<StorageInfo | null> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 由当前档案库导出作业包 */
export async function buildPackageFromDb(source = '内业导出'): Promise<JobPackage> {
  const [plots, trees, regens, rechecks] = await Promise.all([
    db.plots.toArray(),
    db.trees.toArray(),
    db.regens.toArray(),
    db.rechecks.toArray(),
  ]);
  return {
    meta: { packageId: newId('pkg'), source, exportedAt: Date.now(), version: JOB_PACKAGE_VERSION },
    plots,
    trees,
    regens,
    rechecks,
  };
}

export { hashPackage };
