import { Table, Tag } from 'antd';
import type { SyncEntityKind } from '../../types/sync';
import type { Plot } from '../../types/plot';
import type { TreeRecord } from '../../types/tree';
import type { RegenShrub } from '../../types/regen';
import type { RecheckDiff } from '../../types/recheck';

interface FieldDef {
  key: string;
  label: string;
}

const FIELDS: Record<SyncEntityKind, FieldDef[]> = {
  plots: [
    { key: 'plotNo', label: '样地号' },
    { key: 'locality', label: '地点' },
    { key: 'shape', label: '形状' },
    { key: 'area', label: '面积 m²' },
    { key: 'forestType', label: '林型' },
    { key: 'canopyDensity', label: '郁闭度' },
    { key: 'dominantSpecies', label: '优势树种' },
    { key: 'surveyRound', label: '复查期次' },
    { key: 'crew', label: '调查组' },
    { key: 'locked', label: '往期锁定' },
    { key: 'elevation', label: '海拔' },
    { key: 'lng', label: '经度' },
    { key: 'lat', label: '纬度' },
  ],
  trees: [
    { key: 'treeNo', label: '树号' },
    { key: 'species', label: '树种' },
    { key: 'round', label: '期次' },
    { key: 'dbhCm', label: '胸径 cm' },
    { key: 'heightM', label: '树高 m' },
    { key: 'underBranchH', label: '枝下高 m' },
    { key: 'crownWidth', label: '冠幅 m' },
    { key: 'status', label: '状态' },
    { key: 'origin', label: '起源' },
    { key: 'healthClass', label: '健康等级' },
    { key: 'tiltDeg', label: '倾斜 °' },
    { key: 'remark', label: '位置描述' },
  ],
  regens: [
    { key: 'layer', label: '层位' },
    { key: 'species', label: '种类' },
    { key: 'round', label: '期次' },
    { key: 'heightCm', label: '高度 cm' },
    { key: 'count', label: '株数' },
    { key: 'ageGroup', label: '苗龄组' },
    { key: 'distribution', label: '分布' },
    { key: 'browseDamage', label: '啃食情况' },
  ],
  rechecks: [
    { key: 'treeNo', label: '树号' },
    { key: 'species', label: '树种' },
    { key: 'baseRound', label: '上期' },
    { key: 'targetRound', label: '本期' },
    { key: 'baseDbhCm', label: '上期胸径' },
    { key: 'targetDbhCm', label: '本期胸径' },
    { key: 'dbhGrowth', label: '胸径生长量' },
    { key: 'heightGrowth', label: '树高生长量' },
    { key: 'statusChange', label: '状态变化' },
    { key: 'missingReason', label: '缺失原因' },
  ],
};

function fmt(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  return String(value);
}

type AnyEntity = Plot | TreeRecord | RegenShrub | RecheckDiff;

export interface EntityCompareProps {
  kind: SyncEntityKind;
  local?: AnyEntity;
  pack?: AnyEntity;
  /** 高亮哪一边被选中（仅用于行内提示） */
  winner?: 'local' | 'pack';
}

interface CompareRow {
  key: string;
  label: string;
  local: string;
  pack: string;
  differ: boolean;
}

/** 同一条记录站端原档 vs 外业包的逐字段并排比较，差异字段高亮 */
export default function EntityCompare({ kind, local, pack, winner }: EntityCompareProps) {
  const rows: CompareRow[] = FIELDS[kind].map((f) => {
    const lv = (local as Record<string, unknown> | undefined)?.[f.key];
    const pv = (pack as Record<string, unknown> | undefined)?.[f.key];
    return {
      key: f.key,
      label: f.label,
      local: fmt(lv),
      pack: fmt(pv),
      differ: fmt(lv) !== fmt(pv),
    };
  });

  const changed = rows.filter((r) => r.differ).length;

  return (
    <div data-testid={`entity-compare-${kind}`} style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 6 }}>
        <Tag color={changed > 0 ? 'red' : 'default'}>{changed} 个字段两边不一致</Tag>
        {winner ? <Tag color={winner === 'pack' ? 'blue' : 'green'}>已选择采用{winner === 'pack' ? '外业包' : '站端原档'}</Tag> : null}
      </div>
      <Table<CompareRow>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={rows}
        rowClassName={(r) => (r.differ ? 'compare-row-differ' : '')}
        columns={[
          { title: '字段', dataIndex: 'label', width: 130 },
          {
            title: '站端原档',
            dataIndex: 'local',
            render: (v: string, r) => (
              <span style={r.differ ? { color: '#389e0d', fontWeight: 600 } : undefined}>{v}</span>
            ),
          },
          {
            title: '外业作业包',
            dataIndex: 'pack',
            render: (v: string, r) => (
              <span style={r.differ ? { color: '#0958d9', fontWeight: 600 } : undefined}>{v}</span>
            ),
          },
        ]}
      />
    </div>
  );
}
