/** Pure write-scope containment checks. No I/O. */

function normalize(p: string): string {
  const posix = p.replace(/\\/g, '/');
  return posix.startsWith('./') ? posix.slice(2) : posix;
}

const inScope = (p: string, s: string): boolean => (s.endsWith('/') ? p.startsWith(s) : p === s);

export function checkScope(paths: string[], scope: string[]): { ok: boolean; violations: string[] } {
  const normalizedScope = scope.map(normalize);
  const violations: string[] = [];

  for (const rawPath of paths) {
    const path = normalize(rawPath);
    const allowed = normalizedScope.some(s => inScope(path, s));
    if (!allowed) violations.push(rawPath);
  }

  return { ok: violations.length === 0, violations };
}
