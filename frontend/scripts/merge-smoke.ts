/* eslint-disable no-console */
import 'fake-indexeddb/auto';
import assert from 'node:assert';

// 浏览器全局垫片（merge/package 仅在调用时用到）
class LocalStorageShim {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
(globalThis as unknown as { window: unknown }).window = { localStorage: new LocalStorageShim() };
(globalThis as unknown as { navigator: unknown }).navigator = {
  storage: { estimate: async () => ({ quota: 1024 * 1024 * 1024, usage: 0 }) },
};

const { db, invalidateRechecks, revalidatePlotRechecks, loadStaleRechecks, saveRecheckDiffs } = await import(
  '../src/utils/db'
);
const { buildMergePlan, applyMerge } = await import('../src/utils/merge');
const { buildBasePackage, parsePackage, PackageFormatError } = await import('../src/utils/package');
const { stableHash } = await import('../src/utils/hash');
const { plotRev, treeRev, regenRev, recheckRev } = await import('../src/types/sync');
const { usePlotStore } = await import('../src/stores/plotStore');

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, `${name}: got ${String(actual)}, want ${String(expected)}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 基础实体
const P1 = {
  id: 'p1', plotNo: 'FP-001', locality: '一林场', lng: 1, lat: 2, shape: '方形' as const, area: 600,
  elevation: 400, slope: 8, aspect: '东南', forestType: '针阔混交林', canopyDensity: 0.7,
  dominantSpecies: '红松', surveyRound: 2, surveyedAt: 1000, crew: '一组', locked: false, createdAt: 1,
};
const T1 = {
  id: 't1', plotId: 'p1', treeNo: '1', species: '红松', dbhCm: 30, heightM: 18, underBranchH: 7,
  crownWidth: 5, status: '活立木' as const, origin: '天然' as const, healthClass: '健康' as const,
  tiltDeg: 2, remark: '', round: 2, measuredAt: 1000,
};

async function resetDb() {
  await db.transaction('rw', [db.plots, db.trees, db.regens, db.rechecks, db.staleRechecks, db.importLedger], async () => {
    await Promise.all([
      db.plots.clear(), db.trees.clear(), db.regens.clear(),
      db.rechecks.clear(), db.staleRechecks.clear(), db.importLedger.clear(),
    ]);
  });
}

function envPlot(p: typeof P1) {
  return { entity: p, rev: plotRev(p) };
}
function envTree(t: typeof T1) {
  return { entity: t, rev: treeRev(t) };
}
function makeSubmit(parts: {
  plots?: any[]; trees?: any[]; regens?: any[]; rechecks?: any[];
  base?: any; packId?: string;
}) {
  const plots = parts.plots ?? [];
  const trees = parts.trees ?? [];
  const regens = parts.regens ?? [];
  const rechecks = parts.rechecks ?? [];
  return {
    format: 'gbforestplot-workpack' as const,
    formatVersion: 1,
    kind: 'submit' as const,
    station: 'station-field',
    createdAt: 5000,
    note: '',
    baseHash: parts.base ? 'basehash' : '',
    packId:
      parts.packId ??
      stableHash({ plots: plots.map((e: any) => e.rev), trees: trees.map((e: any) => e.rev) }),
    plots,
    trees,
    regens,
    rechecks,
    ...(parts.base ? { base: parts.base } : {}),
  };
}

/* ---------- 场景 A：基线包往返 + 不同样地直接并入 ---------- */
console.log('A. 出队基线 / 不同样地直接并入');
await resetDb();
await db.plots.put(P1);
await db.trees.put(T1);
const basePkg = await buildBasePackage('出队');
eq('基线包类型', basePkg.kind, 'base');
eq('基线包含样地 p1', basePkg.plots[0].entity.id, 'p1');
assert.throws(() => parsePackage('{"x":1}'), PackageFormatError, '非法包被拒绝');
console.log('  ✓ 非法格式作业包解析抛错');
passed += 1;

const P2 = { ...P1, id: 'p2', plotNo: 'FP-002', locality: '二林场', createdAt: 2 };
const submitA = makeSubmit({
  plots: [envPlot(P1), envPlot(P2)],
  trees: [envTree(T1)],
  base: { plots: basePkg.plots, trees: basePkg.trees, regens: [], rechecks: [] },
  packId: 'pack-A',
});
const planA = await buildMergePlan(submitA as any);
eq('新样地判定为 add', planA.counts.add, 1);
eq('无冲突', planA.counts.conflict, 0);
eq('p1 两边一致 → keep 行展示', planA.rows.find((r) => r.id === 'p1')?.action, 'keep');
const resA = await applyMerge(planA);
eq('提交新增 1 条', resA.added, 1);
eq('站端并入了不同样地 p2', (await db.plots.get('p2'))?.plotNo, 'FP-002');

/* ---------- 场景 B：单边改直接采外业；两边都改冲突并排，确认前留原档 ---------- */
console.log('B. 单边修改 / 两边都改冲突');
const P1Local = { ...P1, area: 800 }; // 站端改了面积
const T1Local = { ...T1, dbhCm: 31 }; // 站端改了同一株树胸径
await db.plots.put(P1Local);
await db.trees.put(T1Local);

const baseB = {
  plots: [envPlot(P1), envPlot(P2)],
  trees: [envTree(T1)],
  regens: [],
  rechecks: [],
};
const P2Field = { ...P2, locality: '二林场（南线）' }; // 外业只改了 p2
const T1Field = { ...T1, dbhCm: 33 }; // 外业也改了同一株（不同值）
const submitB = makeSubmit({
  plots: [envPlot(P1), envPlot(P2Field)],
  trees: [envTree(T1Field)],
  base: baseB,
  packId: 'pack-B',
});
const planB = await buildMergePlan(submitB as any);
const t1row = planB.rows.find((r) => r.kind === 'trees' && r.id === 't1');
const p2row = planB.rows.find((r) => r.kind === 'plots' && r.id === 'p2');
const p1row = planB.rows.find((r) => r.kind === 'plots' && r.id === 'p1');
eq('同一株两边都改 → conflict', t1row?.action, 'conflict');
eq('p2 仅外业改 → update', p2row?.action, 'update');
eq('p1 仅站端改 → keep（原档保留）', p1row?.action, 'keep');

// 未解决冲突时提交被拒，且原档不动
await assert.rejects(() => applyMerge(planB), /未选择/);
eq('确认前站端胸径仍是原值 31', (await db.trees.get('t1'))?.dbhCm, 31);
console.log('  ✓ 未决冲突阻止提交');
passed += 1;

// 解决：树采用外业；其余按判定（p2 update、p1 keep）
const resolved = {
  ...planB,
  rows: planB.rows.map((r) => (r.action === 'conflict' ? { ...r, resolution: 'pack' as const } : r)),
};
await applyMerge(resolved);
eq('冲突采用外业后胸径=33', (await db.trees.get('t1'))?.dbhCm, 33);
eq('单边修改采外业 p2 地点更新', (await db.plots.get('p2'))?.locality, '二林场（南线）');
eq('仅站端修改的 p1 面积保留 800', (await db.plots.get('p1'))?.area, 800);

/* ---------- 场景 C：面积/期次改动 → 比对失效；样木指纹精确失效；林分汇总随之重算 ---------- */
console.log('C. 比对结果失效与重算');
// 以合并后的当前状态（面积 800、胸径 33）盖一个新鲜指纹
const plotNow = (await db.plots.get('p1'))!;
const treeNow = (await db.trees.get('t1'))!;
const mkDiff = (over: any = {}) => ({
  id: 'd1', plotId: 'p1', baseRound: 1, targetRound: 2, treeNo: '1', species: '红松',
  baseDbhCm: 28, targetDbhCm: 30, baseHeightM: 17, targetHeightM: 18,
  dbhGrowth: 2, heightGrowth: 1, statusChange: '', missingReason: '', generatedAt: 9000,
  ...over,
});
const diff1 = mkDiff();
const stamped = { ...diff1, contentRev: recheckRev(diff1, plotNow, [treeNow]) };
await saveRecheckDiffs([stamped]);
eq('保存了比对 1 条', (await db.rechecks.where('plotId').equals('p1').count()), 1);

// 精确指纹：改别的样地（p2）不应使 p1 比对失效
await db.plots.put({ ...P2Field });
const n0 = await revalidatePlotRechecks('p1', '无关样地变化');
eq('无关样地改动不误伤', n0, 0);
// 改 p1 样木胸径 → 指纹变化 → 失效
await db.trees.put({ ...treeNow, dbhCm: 31.5 });
const n1 = await revalidatePlotRechecks('p1', '样木量测变化');
ok('相关样木变化使比对失效', n1 >= 1);
eq('失效后档案库比对被移除', await db.rechecks.where('plotId').equals('p1').count(), 0);
eq('失效登记写入 staleRechecks', (await loadStaleRechecks('p1')).length >= 1, true);

// store 路径：样地面积修改 → 整块比对失效（已有一条重新保存的）
const plotNow2 = (await db.plots.get('p1'))!;
const diff2 = mkDiff({ id: 'd2' });
await saveRecheckDiffs([{ ...diff2, contentRev: recheckRev(diff2, plotNow2, [{ ...treeNow, dbhCm: 31.5 }]) }]);
await usePlotStore.getState().load();
await usePlotStore.getState().update('p1', { area: 900 });
eq('面积改动后 store 触发失效', await db.rechecks.where('plotId').equals('p1').count(), 0);
ok('面积失效登记有原因', (await loadStaleRechecks('p1')).some((s) => s.reason.includes('面积')));

/* ---------- 场景 D：重复导入不重复计数 ---------- */
console.log('D. 幂等：重复导入不计数');
const planD = await buildMergePlan(submitB as any);
eq('同包再次预检识别为 duplicate', planD.duplicate, true);
const before = await db.plots.count();
const resD = await applyMerge(planD);
eq('重复提交零新增', resD.added, 0);
eq('重复提交不改数据', await db.plots.count(), before);
const ledger = await db.importLedger.toArray();
eq('导入台账仅 2 条（A、B）', ledger.length, 2);

/* ---------- 场景 E：容量不足拒绝导入，原档完整 ---------- */
console.log('E. 容量闸门');
const planE = await buildMergePlan(submitB as any, { maxPackBytes: 1, maxStorageBytes: 1 });
ok('超容量给出致命原因', !!planE.fatal && planE.fatal!.includes('拒绝导入'));
await assert.rejects(() => applyMerge(planE), /容量/);
eq('拒绝后原档样地数不变', await db.plots.count(), before);
console.log('  ✓ 容量不足零写入');
passed += 1;

/* ---------- 场景 F：事务中途失败整体回滚，可重试 ---------- */
console.log('F. 失败回滚与重试');
const P3 = { ...P1, id: 'p3', plotNo: 'FP-003' };
const T3 = { ...T1, id: 't3', plotId: 'p3', treeNo: '9' };
const submitF = makeSubmit({
  plots: [envPlot(P3)],
  trees: [envTree(T3)],
  base: { plots: [], trees: [], regens: [], rechecks: [] },
  packId: 'pack-F',
});
const planF = await buildMergePlan(submitF as any);
const origPut = db.trees.put.bind(db.trees);
let threwOnce = false;
// @ts-expect-error 运行时打桩
db.trees.put = async (...args: unknown[]) => {
  if (!threwOnce) {
    threwOnce = true;
    throw new Error('模拟写入中断');
  }
  return origPut(...args);
};
await assert.rejects(() => applyMerge(planF), /中断/);
// @ts-expect-error 还原
db.trees.put = origPut;
eq('回滚：样地 p3 未落库', await db.plots.get('p3'), undefined);
eq('回滚：样木 t3 未落库', await db.trees.get('t3'), undefined);
eq('回滚：失败包不记台账（可重试）', await db.importLedger.get('pack-F'), undefined);
// 同一计划重试成功
const resF = await applyMerge(planF);
eq('重试后新增成功', resF.added, 2);
eq('重试后 p3 落库', (await db.plots.get('p3'))?.plotNo, 'FP-003');

/* ---------- 场景 G：无共同祖先时的保守策略（不覆盖本地） ---------- */
console.log('G. 无基线：相同 id 两边都改按冲突处理，绝不静默覆盖');
await db.trees.put({ ...T1, dbhCm: 40 });
const submitG = makeSubmit({
  plots: [],
  trees: [envTree({ ...T1, dbhCm: 50 })],
  packId: 'pack-G',
}); // 无 base
const planG = await buildMergePlan(submitG as any);
const grow = planG.rows.find((r) => r.kind === 'trees' && r.id === 't1');
eq('无共同祖先 + 两边不同 → conflict（需人工）', grow?.action, 'conflict');
eq('确认前本地 40 不变', (await db.trees.get('t1'))?.dbhCm, 40);

console.log(`\n全部通过：${passed} 个断言`);
