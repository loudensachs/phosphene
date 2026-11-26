// NERVE — expression compiler. Parses to closures; no eval.
// Grammar: ternary ?: , || && , comparisons, + - , * / % , unary - ! , ^ (right assoc), calls, identifiers, numbers.

export type Env = (name: string) => number;
export type Compiled = (env: Env) => number;

const fract = (x: number) => x - Math.floor(x);
const h1 = (n: number) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453123);
function noise1(x: number) {
  const i = Math.floor(x), f = x - i, w = f * f * (3 - 2 * f);
  return h1(i) + (h1(i + 1) - h1(i)) * w;
}

export const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt, exp: Math.exp, log: Math.log,
  sign: Math.sign, pow: Math.pow, min: Math.min, max: Math.max, fract,
  mod: (a, b) => a - b * Math.floor(a / b),
  clamp: (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)),
  mix: (a, b, t) => a + (b - a) * t, lerp: (a, b, t) => a + (b - a) * t,
  step: (e, x) => (x < e ? 0 : 1),
  smoothstep: (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
  remap: (x, a, b, c, d) => c + ((x - a) / (b - a)) * (d - c),
  // unit-period oscillators, all 0..1
  saw: x => fract(x),
  tri: x => 1 - Math.abs(fract(x) * 2 - 1),
  sqr: (x, w = 0.5) => (fract(x) < w ? 1 : 0),
  osc: x => 0.5 - 0.5 * Math.cos(x * Math.PI * 2),
  pulse: (x, w = 0.1) => (fract(x) < w ? 1 - fract(x) / w : 0),
  noise: (x, y = 0) => noise1(x + y * 57.31),
  rand: (x = 0) => h1(x),
  ease: x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); },
  if: (c, a, b) => (c ? a : b),
};

export const CONSTS: Record<string, number> = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_$][\w$.]*)|(<=|>=|==|!=|&&|\|\||[-+*/%^(),?:<>!]))/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while (last < src.length) {
    re.lastIndex = last;
    m = re.exec(src);
    if (!m) {
      if (!src.slice(last).trim()) break;
      throw new Error(`Unexpected "${src.slice(last).trim()[0]}"`);
    }
    last = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else out.push({ t: 'op', v: m[3] });
  }
  return out;
}

export function compile(src: string): Compiled {
  const toks = lex(src);
  let i = 0;
  const peek = (v?: string) => { const k = toks[i]; return k && k.t === 'op' && (v === undefined || k.v === v) ? k.v : null; };
  const eat = (v: string) => { if (peek(v)) { i++; return true; } return false; };
  const need = (v: string) => { if (!eat(v)) throw new Error(`Expected "${v}"`); };

  const ternary = (): Compiled => {
    const c = or();
    if (eat('?')) { const a = ternary(); need(':'); const b = ternary(); return e => (c(e) ? a(e) : b(e)); }
    return c;
  };
  const or = (): Compiled => { let l = and(); while (eat('||')) { const a = l, r = and(); l = e => (a(e) || r(e) ? 1 : 0); } return l; };
  const and = (): Compiled => { let l = cmp(); while (eat('&&')) { const a = l, r = cmp(); l = e => (a(e) && r(e) ? 1 : 0); } return l; };
  const cmp = (): Compiled => {
    let l = add();
    for (;;) {
      const o = peek();
      if (o && ['<', '>', '<=', '>=', '==', '!='].includes(o)) {
        i++; const a = l, r = add();
        l = o === '<' ? e => +(a(e) < r(e)) : o === '>' ? e => +(a(e) > r(e)) : o === '<=' ? e => +(a(e) <= r(e))
          : o === '>=' ? e => +(a(e) >= r(e)) : o === '==' ? e => +(a(e) === r(e)) : e => +(a(e) !== r(e));
      } else return l;
    }
  };
  const add = (): Compiled => {
    let l = mul();
    for (;;) {
      if (eat('+')) { const a = l, r = mul(); l = e => a(e) + r(e); }
      else if (eat('-')) { const a = l, r = mul(); l = e => a(e) - r(e); }
      else return l;
    }
  };
  const mul = (): Compiled => {
    let l = unary();
    for (;;) {
      if (eat('*')) { const a = l, r = unary(); l = e => a(e) * r(e); }
      else if (eat('/')) { const a = l, r = unary(); l = e => a(e) / r(e); }
      else if (eat('%')) { const a = l, r = unary(); l = e => { const y = r(e); const x = a(e); return x - y * Math.floor(x / y); }; }
      else return l;
    }
  };
  const unary = (): Compiled => {
    if (eat('-')) { const a = unary(); return e => -a(e); }
    if (eat('+')) return unary();
    if (eat('!')) { const a = unary(); return e => (a(e) ? 0 : 1); }
    return power();
  };
  const power = (): Compiled => {
    const b = atom();
    if (eat('^')) { const p = unary(); return e => Math.pow(b(e), p(e)); }
    return b;
  };
  const atom = (): Compiled => {
    const k = toks[i];
    if (!k) throw new Error('Unexpected end of expression');
    if (k.t === 'num') { i++; const v = k.v; return () => v; }
    if (k.t === 'id') {
      i++;
      const name = k.v;
      if (eat('(')) {
        const args: Compiled[] = [];
        if (!eat(')')) { do args.push(ternary()); while (eat(',')); need(')'); }
        const fn = FUNCS[name];
        if (!fn) {
          // env-provided functions, e.g. fft(x), band(lo, hi): encoded as name|arg|arg lookups
          return e => e(`${name}(${args.map(a => a(e)).join(',')})`);
        }
        if (args.length === 1) { const a = args[0]; return e => fn(a(e)); }
        if (args.length === 2) { const [a, b] = args; return e => fn(a(e), b(e)); }
        return e => fn(...args.map(a => a(e)));
      }
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      return e => e(name);
    }
    if (eat('(')) { const v = ternary(); need(')'); return v; }
    throw new Error(`Unexpected "${k.v}"`);
  };

  const root = ternary();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
  return root;
}

const cache = new Map<string, { fn?: Compiled; err?: string }>();
export function compileCached(src: string): { fn?: Compiled; err?: string } {
  let c = cache.get(src);
  if (!c) {
    try { c = { fn: compile(src) }; } catch (e: any) { c = { err: e.message }; }
    if (cache.size > 4000) cache.clear();
    cache.set(src, c);
  }
  return c;
}
