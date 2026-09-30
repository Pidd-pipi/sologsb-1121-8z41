import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
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
  CheckCircleOutlined,
  DownloadOutlined,
  FileAddOutlined,
  ReloadOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { usePackageStore } from '../stores/packageStore';
import { db } from '../utils/db';
import {
  applyMerge,
  buildMergePlan,
  buildPackageFromDb,
  hashPackage,
  parsePackage,
  rechecksToDelete,
  storageInfo,
  type ApplyResult,
  type LocalSnapshot,
  type MergeError,
  type MergePlan,
  type Resolution,
  type TreeConflict,
  type RegenConflict,
} from '../utils/mergePackage';
import type { JobPackage } from '../types/jobPackage';

const { TextArea } = Input;

type Conflict = TreeConflict | RegenConflict;

function conflictTitle(c: Conflict): string {
  if (c.kind === 'tree') {
    return `${c.plotNo} · 第 ${c.round} 期 · 树号 ${c.treeNo}`;
  }
  return `${c.plotNo} · ${c.local.layer} · ${c.local.species}`;
}

/** /import 作业包导入：回站后合并样木、更新苗与灌木、复查比对结果 */
export default function ImportPackage() {
  const plots = usePlotStore((s) => s.items);
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const loadPlots = usePlotStore((s) => s.load);
  const loadTrees = useTreeStore((s) => s.load);
  const loadRegens = useRegenStore((s) => s.load);
  const imports = usePackageStore((s) => s.items);
  const loadImports = usePackageStore((s) => s.load);

  const [snapshot, setSnapshot] = useState<LocalSnapshot | null>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState('');
  const [pkg, setPkg] = useState<JobPackage | null>(null);
  const [contentHash, setContentHash] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [applying, setApplying] = useState(false);
  const [mergeError, setMergeError] = useState<MergeError | null>(null);
  const [success, setSuccess] = useState<ApplyResult | null>(null);
  const [capWarn, setCapWarn] = useState('');

  useEffect(() => {
    void loadImports();
    void db.rechecks.toArray().then((rechecks) => setSnapshot({ plots, trees, regens, rechecks }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (snapshot) setSnapshot({ plots, trees, regens, rechecks: snapshot.rechecks });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plots, trees, regens]);

  const rechecksToDeleteCount = useMemo(() => {
    if (!plan || !snapshot) return 0;
    return rechecksToDelete(snapshot.rechecks, plan, resolutions).length;
  }, [plan, snapshot, resolutions]);

  const parseText = async (raw: string, name: string) => {
    setParseError('');
    setMergeError(null);
    setSuccess(null);
    const result = parsePackage(raw);
    if (!result.ok) {
      setPkg(null);
      setPlan(null);
      setParseError(result.error);
      return;
    }
    const hash = await hashPackage(result.pkg);
    if (!snapshot) {
      setParseError('本地档案尚未加载完成，请稍后重试');
      return;
    }
    const newPlan = buildMergePlan(snapshot, result.pkg, imports, hash);
    setPkg(result.pkg);
    setContentHash(hash);
    setFileName(name);
    setPlan(newPlan);
    const initial: Record<string, Resolution> = {};
    [...newPlan.treeConflicts, ...newPlan.regenConflicts].forEach((c) => {
      initial[c.key] = 'local'; // 确认前保留原档
    });
    setResolutions(initial);

    // 容量预估：明显放不下时直接拒绝
    const info = await storageInfo();
    if (info && info.quota > 0) {
      const size = new Blob([raw]).size;
      if (info.usage + size > info.quota) {
        setCapWarn(
          `作业包大小约 ${(size / 1024).toFixed(1)} KB，当前本地存储剩余容量不足，合并将被拒绝且保留原档。`,
        );
      } else {
        setCapWarn('');
      }
    }
  };

  const onFile = async (file: File) => {
    setFileName(file.name);
    const raw = await file.text();
    setText(raw);
    await parseText(raw, file.name);
  };

  const apply = async () => {
    if (!plan || !pkg) return;
    setApplying(true);
    setMergeError(null);
    try {
      const result = await applyMerge(plan, resolutions, pkg, contentHash, fileName || '作业包.json');
      await Promise.all([loadPlots(), loadTrees(), loadRegens(), loadImports()]);
      const rechecks = await db.rechecks.toArray();
      setSnapshot((s) => (s ? { ...s, rechecks } : s));
      setSuccess(result);
      setPlan(null);
      setPkg(null);
      setText('');
    } catch (err) {
      setMergeError(err as MergeError);
    } finally {
      setApplying(false);
    }
  };

  const retry = () => {
    setMergeError(null);
    void apply();
  };

  const exportPackage = async () => {
    const pkg = await buildPackageFromDb('内业导出（回站合并用）');
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const day = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `gbforestplot-作业包-${day}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setPkg(null);
    setPlan(null);
    setText('');
    setFileName('');
    setParseError('');
    setMergeError(null);
    setSuccess(null);
    setCapWarn('');
  };

  type ConflictRow = { key: string; label: string; local: string; incoming: string };

  const conflictColumns: TableProps<ConflictRow>['columns'] = [
    { title: '字段', dataIndex: 'label', width: 130 },
    {
      title: '原档（本站数据，确认前保留）',
      dataIndex: 'local',
      render: (v: string) => <Typography.Text>{v}</Typography.Text>,
    },
    {
      title: '新档（作业包）',
      dataIndex: 'incoming',
      render: (v: string) => <Typography.Text style={{ color: '#1677ff' }}>{v}</Typography.Text>,
    },
  ];

  const conflictRows = (c: Conflict) =>
    c.fields.map((f) => ({ key: f.key, label: f.label, local: f.local, incoming: f.incoming }));

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }} data-testid="import-package-page">
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          作业包导入与合并
        </Typography.Title>
        <Tag>回站后合并</Tag>
        <div style={{ flex: 1 }} />
        <Button icon={<DownloadOutlined />} onClick={exportPackage} data-testid="export-package-btn">
          导出作业包
        </Button>
        <Button type="link">
          <Link to="/plots">返回样地台账</Link>
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        message="调查组在山上断网记录，回站后将作业包导入本站：不同样地直接并入；同一株样木或同一条更新记录两边都改过时并排确认，确认前保留原档；样地面积或复查期次改动后，相关比对与林分汇总失效重算；合并失败自动恢复原数据，可重试。"
      />

      {success ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          data-testid="merge-success-alert"
          message="合并完成"
          description={
            <Space direction="vertical" size={4}>
              <span>
                已并入新样地 {success.inserted.plots} 个、样木 {success.inserted.trees} 株、更新与灌木{' '}
                {success.inserted.regens} 条、复查比对 {success.inserted.rechecks} 条；冲突按你的确认保留或采用。
              </span>
              <span>
                已清除过期复查比对 {success.deletedRechecks} 条（样地面积/期次变更或样木更新所致），请回到复查比对页重新生成；林分汇总已按合并后的数据实时重算。
              </span>
              <span>完成结果与导出读取的是同一份合并后的数据。</span>
              <Button size="small" onClick={reset}>
                继续导入下一个作业包
              </Button>
            </Space>
          }
        />
      ) : null}

      <Card size="small" title="1. 选择作业包文件（或粘贴 JSON 内容）">
        <Space wrap align="start">
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            data-testid="package-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = '';
            }}
          />
          <Button
            icon={<UploadOutlined />}
            onClick={() => (document.querySelector('[data-testid=package-file-input]') as HTMLInputElement)?.click()}
          >
            选择作业包文件
          </Button>
          <Typography.Text type="secondary">
            {fileName ? `已选择：${fileName}` : '支持本站导出的 .json 作业包'}
          </Typography.Text>
        </Space>
        <TextArea
          rows={5}
          style={{ marginTop: 10 }}
          placeholder="也可以将作业包 JSON 内容粘贴到此处，然后点击「解析作业包」"
          value={text}
          data-testid="package-paste-area"
          onChange={(e) => setText(e.target.value)}
        />
        <Space style={{ marginTop: 10 }}>
          <Button
            type="primary"
            icon={<FileAddOutlined />}
            data-testid="parse-package-btn"
            onClick={() => void parseText(text, fileName || '粘贴的作业包.json')}
            disabled={!text.trim()}
          >
            解析作业包
          </Button>
          {parseError ? <Typography.Text type="danger">{parseError}</Typography.Text> : null}
        </Space>
      </Card>

      {pkg && plan ? (
        <>
          {plan.duplicate ? (
            <Alert
              type="warning"
              showIcon
              data-testid="duplicate-alert"
              message="该作业包已导入过，重复导入不重复计数"
              description={`此作业包（编号 ${pkg.meta.packageId}）已于 ${new Date(
                plan.importedAt ?? 0,
              ).toLocaleString('zh-CN')} 导入并建档。本次不会再次并入，原档保持不变。`}
            />
          ) : null}

          {capWarn ? <Alert type="warning" showIcon icon={<WarningOutlined />} message={capWarn} /> : null}

          <Card size="small" title="2. 合并计划" data-testid="merge-plan">
            <Descriptions size="small" column={3} data-testid="package-meta">
              <Descriptions.Item label="作业包编号">{pkg.meta.packageId}</Descriptions.Item>
              <Descriptions.Item label="来源">{pkg.meta.source || '—'}</Descriptions.Item>
              <Descriptions.Item label="导出时间">
                {new Date(pkg.meta.exportedAt).toLocaleString('zh-CN')}
              </Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '10px 0' }} />
            <Row gutter={12}>
              <Col span={6}>
                <Statistic title="新并入样地" value={plan.counts.plots} suffix="个" />
              </Col>
              <Col span={6}>
                <Statistic title="新增样木" value={plan.counts.trees} suffix="株" />
              </Col>
              <Col span={6}>
                <Statistic title="新增更新与灌木" value={plan.counts.regens} suffix="条" />
              </Col>
              <Col span={6}>
                <Statistic title="新增复查比对" value={plan.counts.rechecks} suffix="条" />
              </Col>
            </Row>
            <Space wrap size={[8, 4]} style={{ marginTop: 10 }}>
              <Tag color="blue">样地信息变更 {plan.plotChanges.length} 个</Tag>
              <Tag color="orange">样木冲突 {plan.treeConflicts.length} 处</Tag>
              <Tag color="orange">更新记录冲突 {plan.regenConflicts.length} 处</Tag>
              <Tag>复查比对去重跳过 {plan.recheckSkipped} 条</Tag>
              {plan.orphanTrees > 0 ? <Tag color="red">无归属样地样木 {plan.orphanTrees} 株（已跳过）</Tag> : null}
              {plan.orphanRegens > 0 ? <Tag color="red">无归属样地更新记录 {plan.orphanRegens} 条（已跳过）</Tag> : null}
            </Space>

            {plan.plotChanges.length > 0 ? (
              <Alert
                style={{ marginTop: 10 }}
                type="warning"
                showIcon
                message="样地信息变更（同号样地将以作业包为准更新）"
                description={
                  <Space direction="vertical" size={4}>
                    {plan.plotChanges.map((c) => (
                      <span key={c.local.id}>
                        <Tag color={c.areaChanged || c.roundChanged ? 'red' : 'default'}>
                          {c.local.plotNo}
                        </Tag>
                        {c.changedFields.map((f) => `${f.label}：${f.local} → ${f.incoming}`).join('；')}
                        {c.areaChanged || c.roundChanged ? (
                          <Typography.Text type="danger">
                            {' '}
                            （{c.areaChanged ? '面积变更' : ''}
                            {c.areaChanged && c.roundChanged ? '、' : ''}
                            {c.roundChanged ? '复查期次变更' : ''}，相关比对与林分汇总失效重算）
                          </Typography.Text>
                        ) : null}
                      </span>
                    ))}
                  </Space>
                }
              />
            ) : null}

            <Alert
              style={{ marginTop: 10 }}
              type="info"
              showIcon
              data-testid="invalidation-alert"
              message={`失效重算：本次合并将清除 ${rechecksToDeleteCount} 条过期复查比对`}
              description="样地面积或复查期次改动后，相关比对结果作废；样木新增或冲突采用新档后，涉及期次的比对同步失效。请在合并后到复查比对页重新生成，林分汇总则按合并后数据实时重算。"
            />
          </Card>

          {plan.treeConflicts.length + plan.regenConflicts.length > 0 ? (
            <Card
              size="small"
              title="3. 冲突并排确认（确认前保留原档）"
              data-testid="conflict-section"
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {[...plan.treeConflicts, ...plan.regenConflicts].map((c) => (
                  <Card
                    key={c.key}
                    size="small"
                    type="inner"
                    data-testid="conflict-row"
                    title={
                      <Space wrap size={8}>
                        <Tag color={c.kind === 'tree' ? 'green' : 'cyan'}>
                          {c.kind === 'tree' ? '样木' : '更新记录'}
                        </Tag>
                        <span>{conflictTitle(c)}</span>
                      </Space>
                    }
                    extra={
                      <Radio.Group
                        value={resolutions[c.key] ?? 'local'}
                        onChange={(e) =>
                          setResolutions((prev) => ({ ...prev, [c.key]: e.target.value as Resolution }))
                        }
                        data-testid="resolution-radio"
                        optionType="button"
                        buttonStyle="solid"
                        options={[
                          { value: 'local', label: '保留原档' },
                          { value: 'incoming', label: '采用新档' },
                        ]}
                      />
                    }
                  >
                    <Table<{ key: string; label: string; local: string; incoming: string }>
                      size="small"
                      rowKey="key"
                      columns={conflictColumns}
                      dataSource={conflictRows(c)}
                      pagination={false}
                    />
                  </Card>
                ))}
              </Space>
            </Card>
          ) : null}

          {mergeError ? (
            <Alert
              type="error"
              showIcon
              data-testid="merge-error-alert"
              message={mergeError.kind === 'quota' ? '容量不足，已拒绝导入' : '合并失败，已恢复原数据'}
              description={
                <Space direction="vertical" size={8}>
                  <span>{mergeError.message}</span>
                  <Button
                    size="small"
                    type="primary"
                    icon={<ReloadOutlined />}
                    data-testid="retry-merge-btn"
                    onClick={retry}
                  >
                    重试合并
                  </Button>
                </Space>
              }
            />
          ) : null}

          <Card size="small">
            <Space>
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                data-testid="apply-merge-btn"
                loading={applying}
                disabled={plan.duplicate || !!capWarn}
                onClick={() => void apply()}
              >
                确认合并入档
              </Button>
              <Button onClick={reset}>取消</Button>
              <Typography.Text type="secondary">
                合并在一个事务内提交：失败即回滚，原档完整保留，可重试。
              </Typography.Text>
            </Space>
          </Card>
        </>
      ) : null}

      <Card size="small" title="导入历史（重复导入识别）">
        <Table<(typeof imports)[number]>
          size="small"
          rowKey="packageId"
          dataSource={imports}
          data-testid="import-history-table"
          pagination={false}
          locale={{ emptyText: <Empty description="暂无导入记录" /> }}
          columns={[
            { title: '作业包编号', dataIndex: 'packageId' },
            { title: '文件', dataIndex: 'fileName', ellipsis: true },
            {
              title: '导入时间',
              dataIndex: 'importedAt',
              width: 180,
              render: (v: number) => new Date(v).toLocaleString('zh-CN'),
            },
            {
              title: '并入计数',
              width: 260,
              render: (_: unknown, row) =>
                `样地 ${row.counts.plots} · 样木 ${row.counts.trees} · 更新 ${row.counts.regens} · 比对 ${row.counts.rechecks}`,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
