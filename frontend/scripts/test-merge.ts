import { parsePackage, buildMergePlan, rechecksToDelete, type LocalSnapshot } from '../src/utils/mergePackage';
import { hashPackage } from '../src/utils/packageHash';
import type { JobPackage } from '../src/types/jobPackage';
import type { Plot } from '../src/types/plot';
import type { TreeRecord } from '../src/types/tree';
import type { RegenShrub } from '../src/types/regen';
import type { RecheckDiff } from '../src/types/recheck';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name} ${extra}`);
  }
}

const plotA: Plot = {
  id: 'plot_a', plotNo: 'FP-A', locality: 'A地', lng: 1, lat: 2, shape: '方形', area: 600,
  elevation: 100, slope: 5, aspect: '南', forestType: '阔叶林', canopyDensity: 0.7,
  dominantSpecies: '蒙古栎', surveyRound: 2, surveyedAt: 1, crew: '一组', locked: false, createdAt: 1,
};
const plotB: Plot = { ...plotA, id: 'plot_b', plotNo: 'FP-B', area: 400, surveyRound: 1 };

const tree = (over: Partial<TreeRecord> & Pick<TreeRecord, 'id' | 'plotId' | 'treeNo' | 'round'>): TreeRecord => ({
  species: '红松', dbhCm: 20, heightM: 10, underBranchH: 3, crownWidth: 3, status: '活立木',
  origin: '天然', healthClass: '健康', tiltDeg: 0, remark: '', measuredAt: 1, ...over,
});

const local: LocalSnapshot = {
  plots: [plotA, plotB],
  trees: [
    tree({ id: 't1', plotId: 'plot_a', treeNo: '1', round: 1, dbhCm: 20 }),
    tree({ id: 't2', plotId: 'plot_a', treeNo: '2', round: 1, dbhCm: 30 }), // 将与包内一致
    tree({ id: 't3', plotId: 'plot_a', treeNo: '3', round: 2, dbhCm: 25 }), // 冲突：包内改了胸径
    tree({ id: 't4', plotId: 'plot_b', treeNo: '1', round: 1 }),
  ],
  regens: [
    { id: 'r1', plotId: 'plot_a', layer: '更新苗', species: '红松', heightCm: 30, count: 10, ageGroup: '2 年生', distribution: '均匀', browseDamage: '无', round: 2 },
    { id: 'r2', plotId: 'plot_a', layer: '灌木', species: '毛榛', heightCm: 100, count: 20, ageGroup: '多年生', distribution: '团状', browseDamage: '中度', round: 2 },
  ],
  rechecks: [
    { id: 'd1', plotId: 'plot_a', baseRound: 1, targetRound: 2, treeNo: '1', dbhGrowth: 2, heightGrowth: 1, statusChange: '', missingReason: '', generatedAt: 1 },
    { id: 'd2', plotId: 'plot_a', baseRound: 1, targetRound: 2, treeNo: '2', dbhGrowth: 1.5, heightGrowth: 0.8, statusChange: '', missingReason: '', generatedAt: 1 },
    { id: 'd3', plotId: 'plot_b', baseRound: 1, targetRound: 2, treeNo: '1', dbhGrowth: 1, heightGrowth: 0.5, statusChange: '', missingReason: '', generatedAt: 1 },
  ],
};

// 作业包：新样地 FP-NEW；FP-A 面积 600→700；树 3 胸径 25→28（冲突）；新增树 4；树 2 一致；更新苗红松 count 10→15（冲突）；灌木一致；新更新苗；新比对 d4；重复比对 d1
const pkg: JobPackage = {
  meta: { packageId: 'pkg_test_001', source: '野外调查组', exportedAt: 2, version: 1 },
  plots: [
    { ...plotA, area: 700 },
    { ...plotB, id: 'plot_new', plotNo: 'FP-NEW', area: 500, surveyRound: 1 },
  ],
  trees: [
    tree({ id: 'pt1', plotId: 'plot_a', treeNo: '1', round: 1, dbhCm: 20 }), // 一致
    tree({ id: 'pt2', plotId: 'plot_a', treeNo: '2', round: 1, dbhCm: 30 }), // 一致
    tree({ id: 'pt3', plotId: 'plot_a', treeNo: '3', round: 2, dbhCm: 28, measuredAt: 2 }), // 冲突
    tree({ id: 'pt4', plotId: 'plot_a', treeNo: '4', round: 2, dbhCm: 12 }), // 新增
    tree({ id: 'pt5', plotId: 'plot_new', treeNo: '1', round: 1 }), // 新样地新树
  ],
  regens: [
    { id: 'pr1', plotId: 'plot_a', layer: '更新苗', species: '红松', heightCm: 30, count: 15, ageGroup: '2 年生', distribution: '均匀', browseDamage: '无', round: 2 }, // 冲突
    { id: 'pr2', plotId: 'plot_a', layer: '灌木', species: '毛榛', heightCm: 100, count: 20, ageGroup: '多年生', distribution: '团状', browseDamage: '中度', round: 2 }, // 一致
    { id: 'pr3', plotId: 'plot_new', layer: '更新苗', species: '红松', heightCm: 20, count: 30, ageGroup: '1 年生', distribution: '团状', browseDamage: '无', round: 1 }, // 新增
  ],
  rechecks: [
    { id: 'pd1', plotId: 'plot_a', baseRound: 1, targetRound: 2, treeNo: '1', dbhGrowth: 2, heightGrowth: 1, statusChange: '', missingReason: '', generatedAt: 2 }, // 已存在→跳过
    { id: 'pd2', plotId: 'plot_new', baseRound: 0, targetRound: 1, treeNo: '1', dbhGrowth: 0, heightGrowth: 0, statusChange: '', missingReason: '本期新增进界木', generatedAt: 2 }, // 新增
  ],
};

async function main() {
  // 1. 解析
  const parsed = parsePackage(JSON.stringify(pkg));
  check('解析合法作业包', parsed.ok);
  check('拒绝非 JSON', !parsePackage('{not json').ok);
  check('拒绝缺 meta', !parsePackage(JSON.stringify({ plots: [], trees: [], regens: [], rechecks: [] })).ok);
  check('拒绝版本不符', !parsePackage(JSON.stringify({ meta: { packageId: 'x', version: 2 }, plots: [], trees: [], regens: [], rechecks: [] })).ok);
  check('拒绝样地缺面积', !parsePackage(JSON.stringify({ meta: { packageId: 'x', version: 1 }, plots: [{ id: 'p', plotNo: 'P', surveyRound: 1 }], trees: [], regens: [], rechecks: [] })).ok);

  const hash = await hashPackage(pkg);
  check('内容哈希为 64 位十六进制', /^[0-9a-f]{64}$/.test(hash), hash);
  const hash2 = await hashPackage({ ...pkg, meta: { ...pkg.meta, exportedAt: 999 } });
  check('哈希与 meta 无关（仅业务数据）', hash === hash2);

  // 2. 合并计划
  const plan = buildMergePlan(local, pkg, [], hash);
  check('新样地直接并入 1 个', plan.counts.plots === 1, `got ${plan.counts.plots}`);
  check('新样地换发本地 id', plan.plotInserts[0]?.id !== 'plot_new');
  check('新样地样木并入 1 株', plan.treeInserts.some((t) => t.plotId === plan.plotInserts[0].id && t.treeNo === '1' && t.round === 1));
  check('同号样地信息变更 1 个', plan.plotChanges.length === 1);
  check('面积变更被识别', plan.plotChanges[0]?.areaChanged === true);
  check('期次未变更', plan.plotChanges[0]?.roundChanged === false);
  check('样木冲突 1 处（树 3）', plan.treeConflicts.length === 1 && plan.treeConflicts[0].treeNo === '3');
  check('冲突字段含胸径', plan.treeConflicts[0]?.fields.some((f) => f.key === 'dbhCm' && f.local === '25' && f.incoming === '28'), JSON.stringify(plan.treeConflicts[0]?.fields));
  check('新增样木 1 株（树 4）', plan.treeInserts.filter((t) => t.plotId === 'plot_a').length === 1);
  check('更新记录冲突 1 处', plan.regenConflicts.length === 1 && plan.regenConflicts[0].fields.some((f) => f.key === 'count'));
  check('新增更新记录 1 条', plan.regenInserts.length === 1);
  check('复查比对新增 1 条、跳过 1 条', plan.recheckInserts.length === 1 && plan.recheckSkipped === 1);
  check('无孤儿记录', plan.orphanTrees === 0 && plan.orphanRegens === 0);

  // 3. 重复导入
  const dup = buildMergePlan(local, pkg, [{ packageId: 'pkg_test_001', fileName: 'old.json', contentHash: hash, importedAt: 1, counts: { plots: 1, trees: 1, regens: 1, rechecks: 1 } }], hash);
  check('重复导入（packageId）被识别且不并入', dup.duplicate && dup.duplicateReason === 'packageId');
  const dupHash = buildMergePlan(local, pkg, [{ packageId: 'other', fileName: 'old.json', contentHash: hash, importedAt: 1, counts: { plots: 1, trees: 1, regens: 1, rechecks: 1 } }], hash);
  check('重复导入（内容哈希）被识别', dupHash.duplicate && dupHash.duplicateReason === 'contentHash');

  // 4. 失效重算：面积变更 → FP-A 全部比对失效
  const delAll = rechecksToDelete(local.rechecks, plan, {});
  check('面积变更清除该样地全部比对', delAll.length === 2 && delAll.every((d) => d.plotId === 'plot_a'), `got ${delAll.length}`);

  // 期次变更场景
  const roundChangePlan = buildMergePlan(local, { ...pkg, plots: [{ ...plotA, surveyRound: 3 }] }, [], hash);
  const delRound = rechecksToDelete(local.rechecks, roundChangePlan, {});
  check('期次变更清除该样地全部比对', delRound.length === 2);

  // 无变更场景：仅新样木所在期次比对失效
  const stableLocal: LocalSnapshot = {
    ...local,
    plots: [plotA, plotB],
    rechecks: [
      { id: 'd1', plotId: 'plot_a', baseRound: 1, targetRound: 2, treeNo: '1', dbhGrowth: 2, heightGrowth: 1, statusChange: '', missingReason: '', generatedAt: 1 },
      { id: 'd3', plotId: 'plot_b', baseRound: 1, targetRound: 2, treeNo: '1', dbhGrowth: 1, heightGrowth: 0.5, statusChange: '', missingReason: '', generatedAt: 1 },
    ],
  };
  const stablePkg: JobPackage = {
    ...pkg,
    plots: [plotA], // 面积未变
    trees: [tree({ id: 'pt9', plotId: 'plot_a', treeNo: '9', round: 2, dbhCm: 15 })], // 新样木 2 期
    regens: [],
    rechecks: [],
  };
  const stablePlan = buildMergePlan(stableLocal, stablePkg, [], await hashPackage(stablePkg));
  const delStable = rechecksToDelete(stableLocal.rechecks, stablePlan, {});
  check('无面积/期次变更时仅失效涉及期次的比对', delStable.length === 1 && delStable[0].id === 'd1', `got ${delStable.map((d) => d.id)}`);

  // 冲突采用新档 → 该期次比对失效；保留原档 → 不失效
  const conflictPkg: JobPackage = {
    ...pkg,
    plots: [plotA],
    trees: [tree({ id: 'pt3', plotId: 'plot_a', treeNo: '3', round: 2, dbhCm: 28 })],
    regens: [],
    rechecks: [],
  };
  const conflictPlan = buildMergePlan(stableLocal, conflictPkg, [], await hashPackage(conflictPkg));
  const keepLocal = rechecksToDelete(stableLocal.rechecks, conflictPlan, { [conflictPlan.treeConflicts[0].key]: 'local' });
  const takeIncoming = rechecksToDelete(stableLocal.rechecks, conflictPlan, { [conflictPlan.treeConflicts[0].key]: 'incoming' });
  check('冲突保留原档不失效比对', keepLocal.length === 0);
  check('冲突采用新档失效该期次比对', takeIncoming.length === 1 && takeIncoming[0].id === 'd1');

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  if (failures > 0) process.exit(1);
}

void main();
