// Validates every operator pass with naga. Usage: npm run check:wgsl [-- <type> <type> ...]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { registerAll } from '../src/nerve/ops/index';
import { allOps } from '../src/nerve/registry';
import { buildSource, passesOf } from '../src/nerve/wgsl';

registerAll();
const only = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'nerve-wgsl-'));
const naga = join(homedir(), '.cargo/bin/naga');
let bad = 0, n = 0;
const seen = new Set<string>();
for (const def of allOps()) {
  if (seen.has(def.type)) { console.error(`✗ duplicate type ${def.type}`); bad++; }
  seen.add(def.type);
  if (only.length && !only.includes(def.type)) continue;
  if (def.output !== 'sig' && !def.body && !def.cook) { console.error(`✗ ${def.type}: no body or cook`); bad++; }
  if (def.output === 'sig' && !def.sig) { console.error(`✗ ${def.type}: sig op without sig()`); bad++; }
  for (const [name, decl] of Object.entries(passesOf(def))) {
    n++;
    const file = join(dir, `${def.type}.${name}.wgsl`);
    const src = buildSource(decl);
    writeFileSync(file, src);
    if (/\btextureSample\s*\(/.test(decl.body)) { console.error(`✗ ${def.type}:${name}: use textureSampleLevel(tex, smp, uv, 0.0), not textureSample`); bad++; }
    try { execFileSync(naga, [file], { stdio: 'pipe' }); }
    catch (e: any) { bad++; console.error(`✗ ${def.type}:${name}\n${(e.stderr?.toString() || e.message).trim()}\n  (${file})`); }
  }
}
console.log(bad ? `${bad} problem(s) in ${n} passes` : `✓ ${n} passes valid (${allOps().length} operators)`);
process.exit(bad ? 1 : 0);
