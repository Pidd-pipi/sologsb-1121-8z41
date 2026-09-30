import type { JobPackage } from '../types/jobPackage';

/** 作业包业务数据的规范化字符串（用于内容哈希，重复导入识别） */
function canonicalData(pkg: JobPackage): string {
  return JSON.stringify({
    plots: pkg.plots,
    trees: pkg.trees,
    regens: pkg.regens,
    rechecks: pkg.rechecks,
  });
}

/** cyrb53 哈希（subtle 不可用时的兜底，同步、碰撞率低） */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  return h.padStart(16, '0');
}

/** 计算作业包内容哈希：优先 SHA-256，不支持 subtle 时退回 cyrb53 */
export async function hashPackage(pkg: JobPackage): Promise<string> {
  const canonical = canonicalData(pkg);
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    /* 退回同步哈希 */
  }
  return cyrb53(canonical);
}
