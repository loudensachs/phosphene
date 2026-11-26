# NERVE operator authoring guide

Operators live in `src/nerve/ops/*.ts`. Each file exports `ops: OpDef[]`. Types are in `src/nerve/types.ts`;
**read `src/nerve/ops/core.ts` first** — it holds reference implementations of every pattern below.

## Shape of an operator

```ts
const myop: OpDef = {
  type: 'myop',            // unique, lowercase, [a-z0-9]; also the default node name prefix
  label: 'My Op',          // short, Title Case, no emoji
  category: 'Filter',      // see Category in types.ts
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  output: 'tex',           // 'tex' | 'field' | 'sig'
  help: 'One or two plain sentences.',
  params: [ ... ],
  body: `fn op(uv: vec2f) -> vec4f { ... }`,
};
```

### Params
`{ k: 'float', name, def, min, max, step?, unit?, label?, group?, help? }`, `int`, `bool`, `enum` (`options: string[]`, `def` = index),
`vec2` (`def: [x, y]`), `color` (`def: [r,g,b,a]` in sRGB 0..1; arrives in the shader **linear**), `string`.
- `name` is a camelCase WGSL identifier. Do not use WGSL keywords/builtins or the names `g`, `u`, `smp`, `op`, `uv`.
- In the shader: `u.<name>` — float→`f32`, int/bool/enum→`i32` (compare with `== 1`), vec2→`vec2f`, color→`vec4f`.
- Always give `min`/`max` for float/int; they set the slider range (values outside are still allowed via expressions).
- Pick defaults so the op visibly does something tasteful the moment it is dropped in.
- Use `group: 'Name'` to section long param lists. Keep labels terse; `label` defaults to the name.

### Shader environment (single-pass `body`)
- Each tex/field input is a `texture_2d<f32>` bound **under its input name**. Never name a local the same as an input.
- `u.has_<input>` (`f32`, >0.5 when connected) exists for every input. Unconnected inputs sample transparent black.
- Samplers: `smp` (linear clamp), `smpR` (linear repeat), `smpN` (nearest clamp).
- **Always sample with `textureSampleLevel(tex, smp, uv, 0.0)`**. Plain `textureSample` is rejected.
- `uv` is 0..1 with the origin at the **top-left**. Return premult-agnostic RGBA; generators return alpha 1.
- Globals `g.res` (px), `g.time` (s), `g.dt`, `g.beat`, `g.frame`, `g.bpm`, `g.aspect`,
  `g.audio` (bass, mid, high, level), `g.audio2` (kick, lowmid, air, onset).
  Reading `g.time/beat/frame/dt/audio` makes the op re-cook every frame automatically.
- Helpers (see `PRELUDE` in `src/nerve/wgsl.ts`): `PI`, `TAU`, `sat`, `rot`, `luma`, `hash11/21/22/33`, `vnoise`,
  `snoise(vec3f)` (-1..1), `fbm(p, octaves, lacunarity, gain)`, `rgb2hsv`, `hsv2rgb`, `palette`, `centered(uv)`
  (aspect-correct, y spans -1..1), `uncentered(p)`.
- Do not redefine prelude names. Prefix your own helper functions with the op type (`myop_foo`) — every op is a
  separate shader module so collisions between ops are impossible, but collisions with the prelude are not.

### Conventions that keep the library coherent
- **Resolution independence**: express sizes as fractions of image height (`x * g.res.y` for pixels), never raw pixels.
- **Linear HDR**: values may exceed 1. Do not clamp unless the effect requires it. Never apply gamma/sRGB encoding.
- Time-varying effects take a `speed` param and use `g.time * u.speed` (or `g.beat`) — never a hard-coded rate.
- Pass alpha through for filters (`vec4f(rgb, c.a)`).
- Angles in params are degrees (`unit: '°'`), converted with `radians()`.
- WGSL pitfalls: no implicit int↔float conversion (`f32(i)`), `select(falseVal, trueVal, cond)`, `%` on floats is
  truncated remainder (use `x - y * floor(x / y)` for wrap), `switch` cases need braces and a `default`,
  loops need constant-ish bounds (clamp `i32` params before looping, cap at a sane max).

## Multi-pass ops
Declare `passes: { name: { inputs: ['src'], fields: [['radius','f32'], ['dir','vec2f']], body } }` and a `cook(c)`:
`c.run(pass, targetView, [texViews...], { field: value }, [w, h]?)`. Scratch textures: `c.tex('key', w?, h?)` (persistent,
`.fresh` on (re)creation). Final result must land in `c.out`. A texture cannot be read and written in the same pass.
Field types: `f32 | i32 | vec2f | vec3f | vec4f`. See `blur` and `feedback` in core.ts.

## Signal ops (`output: 'sig'`)
No shader. `inputs` are `{ type: 'sig' }`; implement `sig(c: SigCtx): number`. `c.ins[i]` are input values, `c.connected[i]`,
`c.p` params, `c.time/dt/beat/bpm/frame/reset`, `c.audio` (AudioFrame), `c.state` (persistent object — reset it when `c.reset`).
Must be deterministic given sequential frames (no `Math.random()`, no wall clock): export renders frame by frame.

## Checking your work
```
npm run check:wgsl            # validates every pass with naga; must print ✓
npx tsc --noEmit              # must be clean
```
Both must pass before you report done. Do not edit files outside the ones you were assigned.

## Field inputs
A `field` input carries motion/direction vectors in RG (signed, B unused). The Optical Flow operator outputs motion in
uv-per-frame × its Gain (default 40), so `field.rg / 40.0` is the true per-frame uv displacement of the picture.
Multi-pass ops may also pass `opts` as the last argument of `c.run`: `{ viewport: [x, y, w, h], load: true }`.
Reserved WGSL words that have bitten us as field/param names: `smooth`, `mix`, `filter`, `sample`, `target`, `texture`, `step`, `mod`.

## Testing in the real app without a screen
The desktop shell has a scripted mode: it loads the app, evaluates a script, then quits.
```
PHOSPHENE_DEV=1 PHOSPHENE_SHOT=/abs/path/out.png PHOSPHENE_SHOT_DELAY=2000 PHOSPHENE_EVAL="$(cat script.js)" npx electron .
```
(needs the dev server on :5173 — `npm run dev` in the background if it is not already up; `curl -s localhost:5173 >/dev/null && echo up`).
The script is an async IIFE with `window.__phos = { engine, project, actions, ui, exp, host, reg }`. Useful calls:
`project.addNode(type, x, y)`, `project.connect(fromId, toId, slot)`, `project.setParam(id, name, value, false)`,
`project.setDisplay(id)`, `engine.nodeErr(id)`, `engine.gpu.onError = m => ...`, `host.writeFile(absPath, stringOrBytes)` to
write a log, and `actions.importItems([{ path }])` to bring in a clip. Test media: any mp4 made with
`ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 5 -pix_fmt yuv420p out.mp4`. The screenshot is the whole window;
read it to judge the picture. Always collect `engine.nodeErr` for your nodes and GPU errors into the log.
