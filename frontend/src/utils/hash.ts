/**
 * 稳定哈希工具：用于生成实体内容版本号（rev）与作业包内容 ID（packId）。
 * FNV-1a 32 位，输出 8 位十六进制；同内容必同值，字段顺序无关。
 */

export function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** JSON 稳定序列化：对象键排序，避免键顺序影响哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function stableHash(value: unknown): string {
  return hash32(stableStringify(value));
}
