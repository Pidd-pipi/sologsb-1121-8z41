import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  MergeCellsOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  buildBasePackage,
  buildSubmitPackage,
  downloadPackage,
  hasBaseline,
  PackageFormatError,
  parsePackage,
  rememberBaseline,
} from '../utils/package';
import { applyMerge, buildMergePlan, formatBytes, UnresolvedConflictError, type MergeCommitResult } from '../utils/merge';
import { listImports, type ImportLedgerEntry } from '../utils/db';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import {
  MERGE_ACTION_LABEL,
  type MergeAction,
  type MergePlan,
  type MergePlanRow,
  type SyncEntityKind,
} from '../types/sync';
import EntityCompare from '../components/sync/EntityCompare';

const KIND_LABEL: Record<SyncEntityKind, string> = {
  plots: '样地',
  trees: '样木',
  regens: '更新记录',
  rechecks: '复查比对',
};

const KIND_COLOR: Record<SyncEntityKind, string> = {
  plots: 'geekblue',
  trees: 'green',
  regens: 'cyan',
  rechecks: 'purple',
};

const ACTION_COLOR: Record<MergeAction, string> = {
  add: 'green',
  update: 'blue',
  keep: 'default',
  conflict: 'red',
};

type ActionFilter = MergeAction | 'all';

/** /sync 断网作业包：出队导出基线/完成包，回站预检并三方合并 */
export default function SyncCenter() {
  const loadPlots = usePlotStore((s) => s.load);
  const loadTrees = useTreeStore((s) => s.load);
  const loadRegens = useRegenStore((s) => s.load);

  const [note, setNote] = useState('');
  const [baselineReady, setBaselineReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [committed, setCommitted] = useState<MergeCommitResult | null>(null);
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [history, setHistory] = useState<ImportLedgerEntry[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBaselineReady(hasBaseline());
    void listImports().then(setHistory);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const refreshHistory = () => void listImports().then(setHistory);
  const reloadAll = () => Promise.all([loadPlots(), loadTrees(), loadRegens()]);

  const exportBase = async () => {
    setBusy('base');
    setError('');
    try {
      const pkg = await buildBasePackage(note.trim());
      downloadPackage(pkg);
      setBaselineReady(true);
      setToast(`已导出外业基线作业包（${formatBytes(new Blob([JSON.stringify(pkg)]).size)}），本机已记住共同祖先`);
    } catch (e) {
      setError(`导出基线包失败：${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const exportSubmit = async () => {
    setBusy('submit');
    setError('');
    try {
      const pkg = await buildSubmitPackage(note.trim());
      downloadPackage(pkg);
      setToast(
        pkg.baseHash
          ? `已导出外业完成作业包（含出队基线，回站可三方合并）：${formatBytes(new Blob([JSON.stringify(pkg)]).size)}`
          : '已导出完成作业包（本机无基线快照，回站将按保守策略合并，相同记录不会被覆盖）',
      );
    } catch (e) {
      setError(`导出完成包失败：${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const pickFile = () => fileRef.current?.click();

  const onFile = async (file: File) => {
    setError('');
    setCommitted(null);
    try {
      const text = await file.text();
      const pkg = parsePackage(text);
      if (pkg.kind === 'base') {
        // 外业电脑载入基线：只记住共同祖先，不动本机数据
        rememberBaseline(pkg);
        setBaselineReady(true);
        setPlan(null);
        setToast('已载入外业基线作业包作为共同祖先（未改动本机数据）。外业结束请导出「完成作业包」回站合并。');
        return;
      }
      const next = await buildMergePlan(pkg);
      setPlan(next);
      setFilter(next.counts.conflict > 0 ? 'conflict' : 'all');
      if (next.duplicate) {
        setToast('检测到该完成作业包此前已完整并入：重复导入不重复计数，本次不会写入任何数据。');
      } else if (next.fatal) {
        setError(next.fatal);
      } else {
        setToast(
          `预检完成：新增 ${next.counts.add}、单边修改 ${next.counts.update}、两边都改 ${next.counts.conflict}、保留 ${next.counts.keep}`,
        );
      }
    } catch (e) {
      setPlan(null);
      if (e instanceof PackageFormatError) setError(`作业包无法识别：${e.message}（原档完整保留）`);
      else setError(`读取作业包失败：${(e as Error).message}`);
    }
  };

  const setResolution = (rowId: string, resolution: 'local' | 'pack') => {
    setPlan((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) => (r.id === rowId ? { ...r, resolution } : r)),
          }
        : prev,
    );
    setCommitted(null);
  };

  const resolveAll = (resolution: 'local' | 'pack') => {
    setPlan((prev) =>
      prev
        ? { ...prev, rows: prev.rows.map((r) => (r.action === 'conflict' ? { ...r, resolution } : r)) }
        : prev,
    );
    setCommitted(null);
  };

  const unresolved = plan?.rows.filter((r) => r.action === 'conflict' && !r.resolution).length ?? 0;

  const visibleRows = useMemo(
    () => (plan && filter !== 'all' ? plan.rows.filter((r) => r.action === filter) : plan?.rows ?? []),
    [plan, filter],
  );

  const commit = async () => {
    if (!plan) return;
    setBusy('commit');
    setError('');
    try {
      // applyMerge 为单事务：任何失败整体回滚，本地原档完整保留，plan 不变可重试
      const result = await applyMerge(plan);
      if (plan.duplicate) {
        setToast('该作业包已导入过，已跳过，未重复计数。');
      } else {
        await reloadAll();
        setCommitted(result);
        setToast(
          `合并完成：新增 ${result.added}、更新 ${result.updated}、冲突已决 ${result.conflictsResolved}；` +
            `${result.invalidatedRechecks > 0 ? `${result.invalidatedRechecks} 条比对结果失效待重算；` : ''}` +
            `台账、复查与林分汇总、导出均读取合并后的同一份数据。`,
        );
        setPlan(null);
        refreshHistory();
      }
    } catch (e) {
      if (e instanceof UnresolvedConflictError) {
        setError(`${e.message}；请逐行选择保留站端原档或外业包后再确认。`);
      } else {
        setError(`合并失败，已自动恢复原数据（无任何写入），可调整后重试：${(e as Error).message}`);
      }
    } finally {
      setBusy('');
    }
  };

  const columns: NonNullable<TableProps<MergePlanRow>['columns']> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 96,
      render: (kind: SyncEntityKind) => <Tag color={KIND_COLOR[kind]}>{KIND_LABEL[kind]}</Tag>,
    },
    { title: '记录', dataIndex: 'label', ellipsis: true },
    {
      title: '合并判定',
      dataIndex: 'action',
      width: 120,
      render: (action: MergeAction) => <Tag color={ACTION_COLOR[action]}>{MERGE_ACTION_LABEL[action]}</Tag>,
    },
    {
      title: '两边都改时的取舍（确认前保留站端原档）',
      width: 240,
      render: (_: unknown, row: MergePlanRow) =>
        row.action === 'conflict' ? (
          <Radio.Group
            size="small"
            value={row.resolution}
            onChange={(e) => setResolution(row.id, e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="local">站端原档</Radio.Button>
            <Radio.Button value="pack">采用外业</Radio.Button>
          </Radio.Group>
        ) : (
          <Typography.Text type="secondary">
            {row.action === 'add' ? '直接并入新记录' : row.action === 'update' ? '采用外业修改' : '无需改动'}
          </Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          断网作业包 · 合并中心
        </Typography.Title>
        <Tag color={baselineReady ? 'green' : 'default'}>
          {baselineReady ? '本机已记住出队基线' : '本机尚无出队基线'}
        </Tag>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={12}>
        <Col span={12}>
          <Card size="small" title={<Space><CloudUploadOutlined />出队：导出断网作业包</Space>}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Input.TextArea
                rows={2}
                placeholder="备注（可选），如「3 林班一组，两天」"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Space wrap>
                <Button type="primary" icon={<DownloadOutlined />} loading={busy === 'base'} onClick={exportBase}>
                  导出外业基线作业包
                </Button>
                <Button icon={<UploadOutlined />} loading={busy === 'submit'} onClick={exportSubmit}>
                  导出外业完成作业包
                </Button>
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                山上断网用外业电脑：先导入「基线包」开工；外业中直接在本台账录入样木与更新灌木；
                收工导出「完成包」。完成包内含出队基线，回站后可据此识别「仅一边改 / 两边都改」。
              </Typography.Paragraph>
            </Space>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title={<Space><FileSearchOutlined />回站：导入并预检作业包</Space>}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space wrap>
                <Button icon={<MergeCellsOutlined />} onClick={pickFile}>
                  选择作业包 JSON
                </Button>
                {plan ? (
                  <Button icon={<ReloadOutlined />} onClick={() => setPlan(null)}>
                    清空预检结果
                  </Button>
                ) : null}
              </Space>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = '';
                }}
              />
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                预检不写库、不动原档。容量不足或包体超限时直接拒绝导入并完整保留原档；
                同一作业包重复导入会被识别，不重复计数。
              </Typography.Paragraph>
            </Space>
          </Card>
        </Col>
      </Row>

      {plan ? (
        <Card
          size="small"
          title={
            <Space wrap>
              <span>合并预检结果</span>
              <Tag>来自 {plan.pkg.station}</Tag>
              <Tag>{new Date(plan.pkg.createdAt).toLocaleString('zh-CN')}</Tag>
              <Tag color="blue">包体 {formatBytes(plan.packBytes)}</Tag>
              {plan.pkg.note ? <Tag color="default">{plan.pkg.note}</Tag> : null}
            </Space>
          }
        >
          <Row gutter={12}>
            <Col span={4}><Card size="small"><Statistic title="新增并入" value={plan.counts.add} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="单边修改" value={plan.counts.update} valueStyle={{ color: '#0958d9' }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="两边都改" value={plan.counts.conflict} valueStyle={{ color: '#cf1322' }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="保留/一致" value={plan.counts.keep} /></Card></Col>
            <Col span={8}>
              <Card size="small">
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Button type="primary" block disabled={plan.fatal !== undefined || plan.duplicate} loading={busy === 'commit'} onClick={commit}>
                    {unresolved > 0 ? `先解决 ${unresolved} 处冲突` : '确认合并（事务提交）'}
                  </Button>
                  {plan.counts.conflict > 0 ? (
                    <Space size={4}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        冲突批量取舍：
                      </Typography.Text>
                      <Button size="small" onClick={() => resolveAll('local')}>全留原档</Button>
                      <Button size="small" onClick={() => resolveAll('pack')}>全采外业</Button>
                    </Space>
                  ) : null}
                </Space>
              </Card>
            </Col>
          </Row>

          {plan.counts.conflict > 0 ? (
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="同一株样木或同一条更新记录两边都改过：先并排列出差异，逐行选择保留站端原档或采用外业，确认前站端原档不被改动。"
            />
          ) : null}

          <Radio.Group
            style={{ marginTop: 12, marginBottom: 8 }}
            value={filter}
            onChange={(e) => setFilter(e.target.value as ActionFilter)}
            optionType="button"
            options={[
              { value: 'all', label: `全部 ${plan.rows.length}` },
              { value: 'add', label: `新增 ${plan.counts.add}` },
              { value: 'update', label: `单边 ${plan.counts.update}` },
              { value: 'conflict', label: `冲突 ${plan.counts.conflict}` },
              { value: 'keep', label: `保留 ${plan.counts.keep}` },
            ]}
          />

          <Table<MergePlanRow>
            rowKey={(r) => `${r.kind}:${r.id}`}
            size="small"
            columns={columns}
            dataSource={visibleRows}
            pagination={false}
            locale={{ emptyText: '该分类下没有记录' }}
            expandable={{
              rowExpandable: (r) => r.action === 'conflict',
              expandedRowRender: (r) => (
                <EntityCompare
                  kind={r.kind}
                  local={r.local as Parameters<typeof EntityCompare>[0]['local']}
                  pack={r.pack as Parameters<typeof EntityCompare>[0]['pack']}
                  winner={r.resolution}
                />
              ),
            }}
          />
        </Card>
      ) : (
        !committed && <Empty description="尚未导入作业包；回站选择外业完成作业包开始预检" />
      )}

      {committed ? (
        <Card size="small" title="最近一次合并结果">
          <Space wrap size={20}>
            <Tag color="green">新增 {committed.added} 条</Tag>
            <Tag color="blue">更新 {committed.updated} 条</Tag>
            <Tag color="red">冲突取舍 {committed.conflictsResolved} 条</Tag>
            <Tag color={committed.invalidatedRechecks > 0 ? 'orange' : 'default'}>
              失效比对 {committed.invalidatedRechecks} 条
            </Tag>
            <Typography.Text type="secondary">
              涉及样地 {committed.affectedPlotIds.length} 个；完成结果、复查重算与导出均读取合并后的同一份数据
            </Typography.Text>
          </Space>
        </Card>
      ) : null}

      <Card size="small" title={`作业包导入台账（${history.length}）· 幂等去重依据`}>
        <Table<ImportLedgerEntry>
          rowKey="packId"
          size="small"
          pagination={false}
          dataSource={history}
          columns={[
            { title: '包内容 ID', dataIndex: 'packId', width: 220, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 100,
              render: (v: string) => (v === 'base' ? '基线包' : '完成包'),
            },
            { title: '来源站端', dataIndex: 'station', width: 140 },
            {
              title: '导入时间',
              dataIndex: 'importedAt',
              width: 200,
              render: (v: number) => new Date(v).toLocaleString('zh-CN'),
            },
            { title: '新增', dataIndex: 'added', width: 80 },
            { title: '更新', dataIndex: 'updated', width: 80 },
            { title: '跳过/一致', dataIndex: 'skipped', width: 100 },
          ]}
          locale={{ emptyText: '还没有导入过作业包' }}
        />
      </Card>
    </Space>
  );
}
