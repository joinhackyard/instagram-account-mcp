/** Small, dependency-free statistics for A/B tests and channel baselines. */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function variance(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Least-squares line y = a + b·x. */
export function linearFit(xs: number[], ys: number[]): { a: number; b: number } {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const b = den ? num / den : 0;
  return { a: my - b * mx, b };
}

// Regularized incomplete beta via continued fraction (Numerical Recipes), for the t distribution.
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function lgamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for a t statistic with df degrees of freedom. */
export function tTestP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** Welch's t-test (unequal variances). */
export function welch(a: number[], b: number[]): { t: number; df: number; p: number } {
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const t = (mean(b) - mean(a)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { t, df, p: tTestP(t, df) };
}

export const round = (x: number, d = 2) =>
  Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null;

/** Invert a small square matrix (Gauss-Jordan with partial pivoting). Returns null when singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const div = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Ordinary least squares with coefficient t-tests: y = X·beta. Used for A/B tests as
 * value ~ intercept + day + variant dummies, so each variant's effect is estimated with the trend held fixed.
 */
export function ols(
  X: number[][],
  y: number[],
): { beta: number[]; se: number[]; df: number; p: number[] } | null {
  const n = X.length;
  const k = X[0]?.length ?? 0;
  if (n <= k) return null;
  const xtx = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)),
  );
  const inv = invert(xtx);
  if (!inv) return null;
  const xty = Array.from({ length: k }, (_, i) => X.reduce((s, r, idx) => s + r[i] * y[idx], 0));
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const sse = X.reduce(
    (s, r, idx) => s + (y[idx] - r.reduce((t, v, j) => t + v * beta[j], 0)) ** 2,
    0,
  );
  const df = n - k;
  const sigma2 = sse / df;
  const se = inv.map((row, j) => Math.sqrt(Math.max(0, sigma2 * row[j])));
  const p = beta.map((b, j) => (se[j] > 0 ? tTestP(b / se[j], df) : NaN));
  return { beta, se, df, p };
}
