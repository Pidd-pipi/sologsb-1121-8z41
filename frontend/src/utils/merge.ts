import {
  db,
  recordImport,
  revalidatePlotRechecks,
  hasImport,
  type ImportLedgerEntry,
} from './db';
import { stableStringify } from './hash';
import {
  DEFAULT_CAPACITY,
  type CapacityConfig,
  type MergeAction,
  type MergePlan,
  type MergePlanRow,
  type PackEntity,
  type SyncEntityKind,
  type WorkPackage,
  plotRev,
  regenRev,
  recheckRev,
  treeRev,
} from '../types/sync';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';

const KINDS: SyncEntityKind[] = ['plots', 'trees', 'regens', 'rechecks'];

interface LocalData {
  plots: Plot[];
  trees: TreeRecord[];
  regens: RegenShrub[];
  rechecks: RecheckDiff[];
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(stableStringify(value)).length;
}

function localRev(kind: SyncEntityKind, entity: unknown, data: LocalData): string {
  if (kind === 'plots') return plotRev(entity as Plot);
  if (kind === 'trees') return treeRev(entity as TreeRecord);
  if (kind === 'regens') return regenRev(entity as RegenShrub);
  const d = entity as RecheckDiff;
  const plot = data.plots.find((p) => p.id === d.plotId);
  const plotTrees = data.trees.filter((t) => t.plotId === d.plotId);
  return recheckRev(d, plot, plotTrees);
}

function labelFor(kind: SyncEntityKind, entity: unknown, plotNoOf: (plotId: string) => string): string {
  if (kind === 'plots') return `样地 ${(entity as Plot).plotNo}`;
  if (kind === 'trees') {
    const t = entity as TreeRecord;
    return `${plotNoOf(t.plotId)} · 第${t.round}期 ${t.treeNo}号 ${t.species}`;
  }
  if (kind === 'regens') {
    const r = entity as RegenShrub;
    return `${plotNoOf(r.plotId)} · 第${r.round}期 ${r.layer} ${r.species}（${r.count}株）`;
  }
  const d = entity as RecheckDiff;
  return `${plotNoOf(d.plotId)} · 第${d.baseRound}→${d.targetRound}期 ${d.treeNo}号比对`;
}

function plotIdOf(kind: SyncEntityKind, entity: unknown): string {
  if (kind === 'plots') return (entity as Plot).id;
  if (kind === 'trees') return (entity as TreeRecord).plotId;
  if (kind === 'regens') return (entity as RegenShrub).plotId;
  return (entity as RecheckDiff).plotId;
}

function baseCollection(
  kind: SyncEntityKind,
  pkg: WorkPackage,
): PackEntity<Plot>[] | PackEntity<TreeRecord>[] | PackEntity<RegenShrub>[] | PackEntity<RecheckDiff>[] {
  if (pkg.kind === 'submit' && pkg.base) return pkg.base[kind];
  if (pkg.kind === 'base') return pkg[kind];
  return [];
}

/** 合并前预检：建立逐实体的三方合并计划（不写库），并做容量闸门与幂等判定 */
export async function buildMergePlan(
  pkg: WorkPackage,
  capacity: CapacityConfig = DEFAULT_CAPACITY,
): Promise<MergePlan> {
  const packBytes = byteSize(pkg);
  const duplicate = pkg.packId ? await hasImport(pkg.packId) : false;

  let fatal: string | undefined;
  if (packBytes > capacity.maxPackBytes) {
    fatal = `作业包体积 ${formatBytes(packBytes)} 超过本机单包容量上限 ${formatBytes(
      capacity.maxPackBytes,
    )}，已拒绝导入（原档完整保留，未写入任何数据）。`;
  } else if (!duplicate) {
    let available = capacity.maxStorageBytes;
    try {
      const est = await navigator.storage.estimate();
      const quota = Number(est.quota ?? 0);
      const usage = Number(est.usage ?? 0);
      if (quota > 0) available = Math.min(available, Math.max(0, quota - usage));
    } catch {
      /* 部分浏览器不支持 storage.estimate，使用保守常量 */
    }
    if (packBytes > available) {
      fatal = `本机剩余可用存储约 ${formatBytes(available)}，作业包需 ${formatBytes(
        packBytes,
      )}，容量不足，已拒绝导入（原档完整保留）。`;
    }
  }

  const [plots, trees, regens, rechecks] = await Promise.all([
    db.plots.toArray(),
    db.trees.toArray(),
    db.regens.toArray(),
    db.rechecks.toArray(),
  ]);
  const data: LocalData = { plots, trees, regens, rechecks };

  const plotNoMap = new Map<string, string>();
  plots.forEach((p) => plotNoMap.set(p.id, p.plotNo));
  pkg.plots.forEach((e) => plotNoMap.set(e.entity.id, e.entity.plotNo));
  (baseCollection('plots', pkg) as { entity: Plot }[]).forEach((e) =>
    plotNoMap.set(e.entity.id, e.entity.plotNo),
  );
  const plotNoOf = (plotId: string) => plotNoMap.get(plotId) ?? plotId.slice(0, 6);

  const rows: MergePlanRow[] = [];
  KINDS.forEach((kind) => {
    const localList = data[kind] as Array<Plot | TreeRecord | RegenShrub | RecheckDiff>;
    const localById = new Map<string, Plot | TreeRecord | RegenShrub | RecheckDiff>(
      localList.map((e) => [e.id, e]),
    );
    const packById = new Map(pkg[kind].map((e) => [e.entity.id, e]));
    const baseById = new Map(baseCollection(kind, pkg).map((e) => [e.entity.id, e]));
    const ids = Array.from(new Set([...localById.keys(), ...packById.keys()]));

    ids.forEach((id) => {
      const l = localById.get(id);
      const p = packById.get(id);
      const b = baseById.get(id);
      const lRev = l ? localRev(kind, l, data) : undefined;
      const pRev = p?.rev;
      const bRev = b?.rev;

      let action: MergeAction | 'keep-skip';
      if (l && !p) {
        // 本地独有：基线存在且本地未改 → 与本包无关，静默；否则保留本地
        action = bRev !== undefined && bRev === lRev ? 'keep-skip' : 'keep';
      } else if (p && !l) {
        action = 'add';
      } else if (lRev === pRev) {
        action = 'keep';
      } else {
        const localChanged = bRev === undefined || bRev !== lRev;
        const packChanged = bRev === undefined || bRev !== pRev;
        action = localChanged && packChanged ? 'conflict' : packChanged ? 'update' : 'keep';
      }
      if (action === 'keep-skip') return;

      const shown = (p?.entity ?? l) as Plot & TreeRecord & RegenShrub & RecheckDiff;
      rows.push({
        kind,
        id,
        label: labelFor(kind, shown, plotNoOf),
        plotNo: kind === 'plots' ? (shown as Plot).plotNo : plotNoOf(plotIdOf(kind, shown)),
        action,
        baseRev: bRev,
        localRev: lRev,
        packRev: pRev,
        local: l,
        pack: p?.entity,
      });
    });
  });

  const conflicts = rows.filter((r) => r.action === 'conflict');
  const counts = {
    add: rows.filter((r) => r.action === 'add').length,
    update: rows.filter((r) => r.action === 'update').length,
    keep: rows.filter((r) => r.action === 'keep').length,
    conflict: conflicts.length,
  };

  return { pkg, rows, packBytes, fatal, duplicate, conflicts, counts };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export interface MergeCommitResult {
  added: number;
  updated: number;
  kept: number;
  conflictsResolved: number;
  invalidatedRechecks: number;
  affectedPlotIds: string[];
}

/** 未决冲突 */
export class UnresolvedConflictError extends Error {
  constructor(public remaining: number) {
    super(`还有 ${remaining} 处两边都改的记录未选择保留哪一份`);
  }
}

/**
 * 原子提交合并计划：单事务写入，任何一步失败由 IndexedDB 整体回滚，
 * 本地原档完整保留，计划不变可重试。冲突行须先逐行选择 local / pack。
 */
export async function applyMerge(plan: MergePlan): Promise<MergeCommitResult> {
  if (plan.fatal) throw new Error(plan.fatal);
  if (plan.duplicate) {
    return { added: 0, updated: 0, kept: 0, conflictsResolved: 0, invalidatedRechecks: 0, affectedPlotIds: [] };
  }
  const unresolved = plan.rows.filter((r) => r.action === 'conflict' && !r.resolution);
  if (unresolved.length > 0) throw new UnresolvedConflictError(unresolved.length);

  const puts: { kind: SyncEntityKind; value: Plot | TreeRecord | RegenShrub | RecheckDiff; rev: string }[] = [];
  plan.rows.forEach((row) => {
    if (row.action === 'keep') return;
    if (row.action === 'conflict') {
      const usePack = row.resolution === 'pack';
      const value = usePack ? row.pack : row.local;
      const rev = usePack ? row.packRev ?? '' : row.localRev ?? '';
      if (value) puts.push({ kind: row.kind, value: value as Plot | TreeRecord | RegenShrub | RecheckDiff, rev });
      return;
    }
    if (row.pack) {
      puts.push({
        kind: row.kind,
        value: row.pack as Plot | TreeRecord | RegenShrub | RecheckDiff,
        rev: row.packRev ?? '',
      });
    }
  });

  const result: MergeCommitResult = {
    added: plan.counts.add,
    updated: plan.counts.update,
    kept: plan.counts.keep,
    conflictsResolved: plan.counts.conflict,
    invalidatedRechecks: 0,
    affectedPlotIds: [],
  };

  await db.transaction(
    'rw',
    [db.plots, db.trees, db.regens, db.rechecks, db.staleRechecks, db.importLedger],
    async () => {
      const plotIds = new Set<string>();
      for (const put of puts) {
        if (put.kind === 'plots') {
          await db.plots.put(put.value as Plot);
          plotIds.add((put.value as Plot).id);
        } else if (put.kind === 'trees') {
          await db.trees.put(put.value as TreeRecord);
          plotIds.add((put.value as TreeRecord).plotId);
        } else if (put.kind === 'regens') {
          await db.regens.put(put.value as RegenShrub);
          plotIds.add((put.value as RegenShrub).plotId);
        } else {
          const d = put.value as RecheckDiff;
          await db.rechecks.put(put.rev ? { ...d, contentRev: put.rev } : d);
          plotIds.add(d.plotId);
        }
      }

      // 提交后按指纹复核受影响样地的比对结果：过期的失效重算，未过期保留
      let invalidated = 0;
      for (const plotId of plotIds) {
        invalidated += await revalidatePlotRechecks(
          plotId,
          '作业包合并带入样地面积/期次或样木变化，比对结果失效待重算',
        );
      }
      result.invalidatedRechecks = invalidated;
      result.affectedPlotIds = Array.from(plotIds);

      const entry: ImportLedgerEntry = {
        packId: plan.pkg.packId,
        kind: plan.pkg.kind,
        station: plan.pkg.station,
        importedAt: Date.now(),
        added: result.added,
        updated: result.updated,
        skipped: result.kept,
      };
      await recordImport(entry);
    },
  );

  return result;
}
