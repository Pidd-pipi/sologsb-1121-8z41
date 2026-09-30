import type { Plot } from './plot';
import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';
import type { RecheckDiff } from './recheck';
import { stableHash } from '../utils/hash';

/** 同步实体类型 */
export type SyncEntityKind = 'plots' | 'trees' | 'regens' | 'rechecks';

export const SYNC_ENTITY_KINDS: SyncEntityKind[] = ['plots', 'trees', 'regens', 'rechecks'];

/** 作业包类型：base=外业基线包（出队导出），submit=外业完成包（回站合并） */
export type PackageKind = 'base' | 'submit';

export const PACKAGE_FORMAT = 'gbforestplot-workpack';
export const PACKAGE_FORMAT_VERSION = 1;

/** 单个实体在包里的信封：实体本体 + 内容版本号 rev + 删除标记 */
export interface PackEntity<T> {
  entity: T;
  /** 内容版本号：由业务字段算出，与存储行 id 无关 */
  rev: string;
  /** 外业端删除（仅 submit 包使用；当前版本不产生删除，保留扩展位） */
  deleted?: boolean;
}

/** 断网作业包 */
export interface WorkPackage {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  kind: PackageKind;
  /** 出包站端标识（同一台浏览器保持稳定），仅用于冲突提示 */
  station: string;
  createdAt: number;
  note: string;
  /** submit 包回溯的 base 包内容哈希；base 包为空串 */
  baseHash: string;
  /** 包内容唯一 ID（对全部实体内容取哈希），用于幂等去重 */
  packId: string;
  plots: PackEntity<Plot>[];
  trees: PackEntity<TreeRecord>[];
  regens: PackEntity<RegenShrub>[];
  rechecks: PackEntity<RecheckDiff>[];
  /**
   * submit 包内嵌的出队基线快照（共同祖先），用于站端真三方合并；
   * 不纳入 packId 之外的业务判读，站端只据此识别「仅一边改 / 两边都改」。
   */
  base?: {
    plots: PackEntity<Plot>[];
    trees: PackEntity<TreeRecord>[];
    regens: PackEntity<RegenShrub>[];
    rechecks: PackEntity<RecheckDiff>[];
  };
}

/** 合并动作 */
export type MergeAction = 'add' | 'update' | 'keep' | 'conflict';

export const MERGE_ACTION_LABEL: Record<MergeAction, string> = {
  add: '新增并入',
  update: '单边修改',
  keep: '保留',
  conflict: '两边都改',
};

/** 单个实体的合并计划行 */
export interface MergePlanRow {
  kind: SyncEntityKind;
  id: string;
  /** 展示用名称（样地号 / 树号 / 更新种类 / 树号比对） */
  label: string;
  plotNo: string;
  action: MergeAction;
  /** 基线版本（不存在为 undefined） */
  baseRev?: string;
  /** 站端当前版本 */
  localRev?: string;
  /** 作业包版本 */
  packRev?: string;
  local?: unknown;
  pack?: unknown;
  /** 冲突时调查员选择：local=保留原档，pack=采用外业；未决为空 */
  resolution?: 'local' | 'pack';
}

/** 合并计划预检结果 */
export interface MergePlan {
  pkg: WorkPackage;
  rows: MergePlanRow[];
  /** 包体估算大小（字节，UTF-8） */
  packBytes: number;
  /** 预检阶段发现的致命问题（容量不足、格式错误等） */
  fatal?: string;
  /** 重复导入：该包此前已完整并入 */
  duplicate: boolean;
  conflicts: MergePlanRow[];
  counts: {
    add: number;
    update: number;
    keep: number;
    conflict: number;
  };
}

/** 容量配置 */
export interface CapacityConfig {
  /** 单个作业包体积上限（字节） */
  maxPackBytes: number;
  /** IndexedDB 预计可新增占用上限（字节，navigator.storage.estimate 兜底） */
  maxStorageBytes: number;
}

export const DEFAULT_CAPACITY: CapacityConfig = {
  maxPackBytes: 5 * 1024 * 1024,
  maxStorageBytes: 50 * 1024 * 1024,
};

/* ---------------- 实体业务字段（剔除本地/派生字段）与 rev ---------------- */

const PLID_FIELDS: (keyof Plot)[] = [
  'plotNo', 'locality', 'lng', 'lat', 'shape', 'area', 'elevation', 'slope', 'aspect',
  'forestType', 'canopyDensity', 'dominantSpecies', 'surveyRound', 'surveyedAt', 'crew', 'locked',
];

const TREE_FIELDS: (keyof TreeRecord)[] = [
  'plotId', 'treeNo', 'species', 'dbhCm', 'heightM', 'underBranchH', 'crownWidth',
  'status', 'origin', 'healthClass', 'tiltDeg', 'remark', 'round', 'measuredAt',
];

const REGEN_FIELDS: (keyof RegenShrub)[] = [
  'plotId', 'layer', 'species', 'heightCm', 'count', 'ageGroup', 'distribution', 'browseDamage', 'round',
];

/**
 * 复查比对的业务签名：不直接对 diff 行整体取哈希——
 * 样地面积、复查期次或任一相关样木量测值变化后，比对结果即应失效重算，
 * 因此指纹纳入 plot.area / surveyRound 与该样地全部样木的量测值。
 */
export function recheckFingerprint(
  diff: RecheckDiff,
  plot: Plot | undefined,
  plotTrees: TreeRecord[],
): string {
  if (!plot) return 'no-plot';
  const treeSig = plotTrees
    .filter((t) => t.round === diff.baseRound || t.round === diff.targetRound)
    .map((t) => `${t.round}:${t.treeNo}:${t.dbhCm}:${t.heightM}:${t.status}`)
    .sort()
    .join('|');
  return stableHash({
    area: plot.area,
    surveyRound: plot.surveyRound,
    baseRound: diff.baseRound,
    targetRound: diff.targetRound,
    treeSig,
  });
}

function pick<T extends object>(row: T, fields: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  fields.forEach((f) => {
    out[f] = row[f];
  });
  return out;
}

export function plotRev(p: Plot): string {
  return stableHash(pick(p, PLID_FIELDS));
}

export function treeRev(t: TreeRecord): string {
  return stableHash(pick(t, TREE_FIELDS));
}

export function regenRev(r: RegenShrub): string {
  return stableHash(pick(r, REGEN_FIELDS));
}

/**
 * 复查比对行 rev：业务字段 + 指纹（面积/期次/样木变化会改变 rev，
 * 从而在合并时被识别为「需失效重算」的过期结果）。
 */
export function recheckRev(d: RecheckDiff, plot?: Plot, plotTrees: TreeRecord[] = []): string {
  const fields: Partial<RecheckDiff> = {
    plotId: d.plotId,
    baseRound: d.baseRound,
    targetRound: d.targetRound,
    treeNo: d.treeNo,
    species: d.species,
    baseDbhCm: d.baseDbhCm,
    targetDbhCm: d.targetDbhCm,
    baseHeightM: d.baseHeightM,
    targetHeightM: d.targetHeightM,
    dbhGrowth: d.dbhGrowth,
    heightGrowth: d.heightGrowth,
    statusChange: d.statusChange,
    missingReason: d.missingReason,
  };
  return stableHash({ fields, fp: recheckFingerprint(d, plot, plotTrees) });
}
