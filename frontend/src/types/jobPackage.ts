import type { Plot } from './plot';
import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';
import type { RecheckDiff } from './recheck';

/** 作业包格式版本 */
export const JOB_PACKAGE_VERSION = 1;

/** 作业包元信息 */
export interface PackageMeta {
  /** 作业包唯一编号（导出时生成） */
  packageId: string;
  /** 来源：调查组 / 设备 */
  source: string;
  /** 导出时间 ms */
  exportedAt: number;
  version: number;
}

/**
 * 作业包：调查组在山上断网记录后，回站并入档案库的数据包。
 * 包含样地、样木、更新苗与灌木样方、复查逐株比对结果。
 */
export interface JobPackage {
  meta: PackageMeta;
  plots: Plot[];
  trees: TreeRecord[];
  regens: RegenShrub[];
  rechecks: RecheckDiff[];
}

/** 已导入档案记录（用于重复导入识别） */
export interface ImportRecord {
  packageId: string;
  fileName: string;
  /** 数据内容哈希（meta 之外的业务数据） */
  contentHash: string;
  importedAt: number;
  /** 实际并入计数 */
  counts: {
    plots: number;
    trees: number;
    regens: number;
    rechecks: number;
  };
}
