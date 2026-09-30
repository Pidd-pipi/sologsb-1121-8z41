import { db, getStationId } from './db';
import { stableHash } from './hash';
import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type PackEntity,
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

const LS_BASELINE_KEY = 'gbforestplot:baseline-pkg';

function envelope<T>(entity: T, rev: string): PackEntity<T> {
  return { entity, rev };
}

/** 读出本地全部实体，并按合并所需的 rev 装信封 */
async function snapshot() {
  const [plots, trees, regens, rechecks] = await Promise.all([
    db.plots.toArray(),
    db.trees.toArray(),
    db.regens.toArray(),
    db.rechecks.toArray(),
  ]);
  const plotMap = new Map(plots.map((p) => [p.id, p]));
  const treesOf = (plotId: string) => trees.filter((t) => t.plotId === plotId);
  return {
    plots: plots.map((p) => envelope<Plot>(p, plotRev(p))),
    trees: trees.map((t) => envelope<TreeRecord>(t, treeRev(t))),
    regens: regens.map((r) => envelope<RegenShrub>(r, regenRev(r))),
    rechecks: rechecks.map((d) =>
      envelope<RecheckDiff>(d, recheckRev(d, plotMap.get(d.plotId), treesOf(d.plotId))),
    ),
  };
}

/** 包内容唯一 ID：与出包时间、站端无关，同内容同 ID（幂等去重依据） */
function computePackId(p: Pick<WorkPackage, 'kind' | 'baseHash' | 'plots' | 'trees' | 'regens' | 'rechecks'>): string {
  return stableHash({
    format: PACKAGE_FORMAT,
    kind: p.kind,
    baseHash: p.baseHash,
    plots: p.plots.map((e) => e.rev),
    trees: p.trees.map((e) => e.rev),
    regens: p.regens.map((e) => e.rev),
    rechecks: p.rechecks.map((e) => e.rev),
  });
}

/** 基线作业包内容哈希（完成包据此回溯共同祖先） */
export function packageHash(pkg: WorkPackage): string {
  return stableHash({
    kind: pkg.kind,
    station: pkg.station,
    plots: pkg.plots.map((e) => e.rev),
    trees: pkg.trees.map((e) => e.rev),
    regens: pkg.regens.map((e) => e.rev),
    rechecks: pkg.rechecks.map((e) => e.rev),
  });
}

/** 出队：导出外业基线作业包，并在本机记住基线（供随后导出完成包做三方合并） */
export async function buildBasePackage(note = ''): Promise<WorkPackage> {
  const snap = await snapshot();
  const pkg: WorkPackage = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    kind: 'base',
    station: getStationId(),
    createdAt: Date.now(),
    note,
    baseHash: '',
    packId: '',
    ...snap,
  };
  pkg.packId = computePackId(pkg);
  try {
    window.localStorage.setItem(LS_BASELINE_KEY, JSON.stringify(pkg));
  } catch {
    /* 记不住基线时仍可出包，回站合并退化为无共同祖先的保守策略 */
  }
  return pkg;
}

/** 回站：导出外业完成作业包（内嵌出队时基线快照，供站端三方合并） */
export async function buildSubmitPackage(note = ''): Promise<WorkPackage> {
  const snap = await snapshot();
  let base: Pick<WorkPackage, 'plots' | 'trees' | 'regens' | 'rechecks'> | undefined;
  let baseHash = '';
  try {
    const raw = window.localStorage.getItem(LS_BASELINE_KEY);
    if (raw) {
      const baseline = JSON.parse(raw) as WorkPackage;
      if (baseline.kind === 'base' && baseline.format === PACKAGE_FORMAT) {
        base = {
          plots: baseline.plots,
          trees: baseline.trees,
          regens: baseline.regens,
          rechecks: baseline.rechecks,
        };
        baseHash = baseline.packId;
      }
    }
  } catch {
    /* 基线不可读时按无共同祖先处理 */
  }
  const pkg: WorkPackage = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    kind: 'submit',
    station: getStationId(),
    createdAt: Date.now(),
    note,
    baseHash,
    packId: '',
    ...snap,
    ...(base ? { base } : {}),
  };
  pkg.packId = computePackId(pkg);
  return pkg;
}

/** 外业电脑载入基线作业包：仅记住共同祖先，不改动本机数据 */
export function rememberBaseline(pkg: WorkPackage): void {
  if (pkg.kind !== 'base') throw new Error('仅基线作业包可载入为外业基线');
  window.localStorage.setItem(LS_BASELINE_KEY, JSON.stringify(pkg));
}

export function hasBaseline(): boolean {
  try {
    return !!window.localStorage.getItem(LS_BASELINE_KEY);
  } catch {
    return false;
  }
}

/* ---------------- 文件读写 ---------------- */

export class PackageFormatError extends Error {}

export function parsePackage(text: string): WorkPackage {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PackageFormatError('文件不是合法的 JSON 作业包');
  }
  const pkg = data as Partial<WorkPackage>;
  if (!pkg || pkg.format !== PACKAGE_FORMAT) {
    throw new PackageFormatError('文件格式不符：缺少 gbforestplot 作业包标识');
  }
  if (pkg.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new PackageFormatError(
      `作业包结构版本为 v${pkg.formatVersion ?? '?'}，本机仅支持 v${PACKAGE_FORMAT_VERSION}`,
    );
  }
  if (pkg.kind !== 'base' && pkg.kind !== 'submit') {
    throw new PackageFormatError('作业包类型未知（应为 base 基线包或 submit 完成包）');
  }
  for (const k of ['plots', 'trees', 'regens', 'rechecks'] as const) {
    if (!Array.isArray(pkg[k])) throw new PackageFormatError(`作业包内容不完整：缺少 ${k}`);
  }
  return pkg as WorkPackage;
}

export function downloadPackage(pkg: WorkPackage): void {
  const stamp = new Date(pkg.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
  const name =
    pkg.kind === 'base'
      ? `外业基线作业包_${stamp}_${pkg.packId.slice(0, 6)}.json`
      : `外业完成作业包_${stamp}_${pkg.packId.slice(0, 6)}.json`;
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
