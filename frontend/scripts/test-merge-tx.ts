import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import { applyMerge, buildMergePlan, type LocalSnapshot } from '../src/utils/mergePackage';
import { hashPackage } from '../src/utils/packageHash';
import type { JobPackage } from '../src/types/jobPackage';
import type { Plot } from '../src/types/plot';
import type { TreeRecord } from '../src/types/tree';
import type { RecheckDiff } from '../src/types/recheck';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name} ${extra}`);
  }
}

const plot: Plot = {
  id: 'plot_a', plotNo: 'FP-A', locality: 'A', lng: 1, lat: 2, shape: '方形', area: 600,
  elevation: 100, slope: 5, aspect: '南', forestType: '阔叶林', canopyDensity: 0.7,
  dominantSpecies: '蒙古栎', surveyRound: 2, surveyedAt: 1, crew: '一组', locked: false, createdAt: 1,
};
const tree: TreeRecord = {
  id: 't1', plotId: 'plot_a', treeNo: '1', species: '红松', dbhCm: 20, heightM: 10,
  underBranchH: 3, crownWidth: 3, status: '活立木', origin: '天然', healthClass: '健康',
  tiltDeg: 0, remark: '', round: 1, measuredAt: 1,
};
const recheck: RecheckDiff = {
  id: 'd1', plotId: 'plot_a', baseRound: 1, targetRound: 2, treeNo: '1', species: '红松',
  dbhGrowth: 2, heightGrowth: 1, statusChange: '', missingReason: '', generatedAt: 1,
};

async function resetDb() {
  await db.delete();
  await db.open();
  await db.plots.put(plot);
  await db.trees.put(tree);
  await db.rechecks.put(recheck);
}

function makePackage(over: Partial<JobPackage> = {}): JobPackage {
  return {
    meta: { packageId: 'pkg_tx', source: '野外组', exportedAt: 2, version: 1 },
    plots: [{ ...plot, area: 700 }], // 面积变更 → 比对失效
    trees: [{ ...tree, id: 'pt1', treeNo: '2', round: 2, dbhCm: 12 }], // 新样木
    regens: [],
    rechecks: [],
    ...over,
  };
}

async function snapshot(): Promise<LocalSnapshot> {
  return {
    plots: await db.plots.toArray(),
    trees: await db.trees.toArray(),
    regens: await db.regens.toArray(),
    rechecks: await db.rechecks.toArray(),
  };
}

async function main() {
  // ---- 用例 1：成功提交 ----
  await resetDb();
  const pkg1 = makePackage();
  const plan1 = buildMergePlan(await snapshot(), pkg1, [], await hashPackage(pkg1));
  const result1 = await applyMerge(plan1, {}, pkg1, await hashPackage(pkg1), 'a.json');
  check('成功：新样木计数 1', result1.inserted.trees === 1);
  check('成功：过期比对清除 1 条', result1.deletedRechecks === 1);
  const treesAfter = await db.trees.toArray();
  check('成功：样木已入库（原 1 + 新 1）', treesAfter.length === 2);
  check('成功：原档样木保留', treesAfter.some((t) => t.id === 't1'));
  const rechecksAfter = await db.rechecks.toArray();
  check('成功：失效比对已删除', rechecksAfter.length === 0);
  const importsAfter = await db.imports.toArray();
  check('成功：导入档案已记录', importsAfter.length === 1 && importsAfter[0].packageId === 'pkg_tx');

  // ---- 用例 2：容量不足 → 拒绝并回滚 ----
  await resetDb();
  const pkg2 = makePackage();
  const plan2 = buildMergePlan(await snapshot(), pkg2, [], await hashPackage(pkg2));
  const originalBulkDelete = db.rechecks.bulkDelete.bind(db.rechecks);
  db.rechecks.bulkDelete = (async () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }) as never;
  let err2: unknown = null;
  try {
    await applyMerge(plan2, {}, pkg2, await hashPackage(pkg2), 'b.json');
  } catch (e) {
    err2 = e;
  }
  check('容量不足：抛出 MergeError', !!err2 && (err2 as { name?: string }).name === 'MergeError');
  check('容量不足：kind=quota', (err2 as { kind?: string })?.kind === 'quota');
  const treesKept = await db.trees.toArray();
  const rechecksKept = await db.rechecks.toArray();
  const importsKept = await db.imports.toArray();
  check('容量不足：样木原档完整（未写入新样木）', treesKept.length === 1 && treesKept[0].id === 't1');
  check('容量不足：比对原档完整（未删除）', rechecksKept.length === 1 && rechecksKept[0].id === 'd1');
  check('容量不足：样地面积恢复 600 m²', (await db.plots.get('plot_a'))?.area === 600);
  check('容量不足：未产生导入记录', importsKept.length === 0);
  db.rechecks.bulkDelete = originalBulkDelete as never;

  // ---- 用例 3：普通失败 → 回滚 → 重试成功 ----
  await resetDb();
  const pkg3 = makePackage();
  const plan3 = buildMergePlan(await snapshot(), pkg3, [], await hashPackage(pkg3));
  const originalBulkPut = db.trees.bulkPut.bind(db.trees);
  let failNext = true;
  db.trees.bulkPut = (async (rows: TreeRecord[]) => {
    if (failNext) throw new Error('模拟写入中断');
    return originalBulkPut(rows);
  }) as never;
  let err3: unknown = null;
  try {
    await applyMerge(plan3, {}, pkg3, await hashPackage(pkg3), 'c.json');
  } catch (e) {
    err3 = e;
  }
  check('失败：kind=failed', (err3 as { kind?: string })?.kind === 'failed');
  check('失败后回滚：样木仍为 1 株', (await db.trees.toArray()).length === 1);
  check('失败后回滚：比对仍在', (await db.rechecks.toArray()).length === 1);
  check('失败后回滚：样地面积恢复 600 m²', (await db.plots.get('plot_a'))?.area === 600);
  check('失败后回滚：无导入记录', (await db.imports.toArray()).length === 0);
  // 重试
  failNext = false;
  const result3 = await applyMerge(plan3, {}, pkg3, await hashPackage(pkg3), 'c.json');
  check('重试成功：样木 2 株', result3.inserted.trees === 1 && (await db.trees.toArray()).length === 2);
  check('重试成功：导入记录已建档', (await db.imports.toArray()).length === 1);
  db.trees.bulkPut = originalBulkPut as never;

  // ---- 用例 4：重复导入不重复计数 ----
  const pkg4 = makePackage({ meta: { packageId: 'pkg_tx', source: '野外组', exportedAt: 2, version: 1 } });
  const snap4 = await snapshot();
  const plan4 = buildMergePlan(snap4, pkg4, await db.imports.toArray(), await hashPackage(pkg4));
  check('重复导入被标记', plan4.duplicate);
  check('重复导入不新增样木', plan4.treeInserts.length === 0);

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  if (failures > 0) process.exit(1);
}

void main();
