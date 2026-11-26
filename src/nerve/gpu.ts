// NERVE — WebGPU device wrapper and fullscreen pass runner.
import type { PassDecl, Vals } from './types';
import { buildSource, G_SIZE, layoutOf, passFields, writeUniforms, type Layout } from './wgsl';

export const TEX_FORMAT: GPUTextureFormat = 'rgba16float';
const TEX_USAGE = 0x10 /*RENDER_ATTACHMENT*/ | 0x04 /*TEXTURE_BINDING*/ | 0x01 /*COPY_SRC*/ | 0x02 /*COPY_DST*/;

export class Gpu {
  device!: GPUDevice;
  canvasFormat!: GPUTextureFormat;
  gbuf!: GPUBuffer;
  gdata = new Float32Array(G_SIZE / 4);
  smp!: GPUSampler; smpR!: GPUSampler; smpN!: GPUSampler;
  black!: GPUTextureView;
  lost = false;
  onError: (msg: string) => void = m => console.error('[NERVE]', m);

  static async create(): Promise<Gpu> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this runtime.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const g = new Gpu();
    g.device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D) },
    });
    g.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    const d = g.device;
    d.lost.then(i => { g.lost = true; g.onError(`GPU device lost: ${i.message}`); });
    d.onuncapturederror = e => g.onError(e.error.message);
    g.gbuf = d.createBuffer({ size: G_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    g.smp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    g.smpR = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    g.smpN = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bt = g.texture(1, 1);
    g.black = bt.createView();
    return g;
  }

  texture(w: number, h: number, format: GPUTextureFormat = TEX_FORMAT): GPUTexture {
    return this.device.createTexture({ size: [Math.max(1, w | 0), Math.max(1, h | 0)], format, usage: TEX_USAGE });
  }

  copy(src: GPUTexture, dst: GPUTexture) {
    if (src.width !== dst.width || src.height !== dst.height) return;
    const e = this.device.createCommandEncoder();
    e.copyTextureToTexture({ texture: src }, { texture: dst }, [src.width, src.height]);
    this.device.queue.submit([e.finish()]);
  }

  clear(target: GPUTextureView) {
    const e = this.device.createCommandEncoder();
    e.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
    this.device.queue.submit([e.finish()]);
  }
}

export interface RunOpts { viewport?: [number, number, number, number]; load?: boolean }

/** A compiled fullscreen fragment pass with its own uniform buffer. */
export class Pass {
  private pipeline: GPURenderPipeline;
  private bgl: GPUBindGroupLayout;
  private ubuf: GPUBuffer;
  private lay: Layout;
  private data: ArrayBuffer;
  private dv: DataView;
  readonly nIn: number;
  private inputs: string[];

  constructor(private gpu: Gpu, decl: PassDecl, format: GPUTextureFormat = TEX_FORMAT, label = 'pass') {
    const d = gpu.device;
    this.inputs = decl.inputs;
    this.nIn = decl.inputs.length;
    this.lay = layoutOf(passFields(decl));
    this.data = new ArrayBuffer(this.lay.size);
    this.dv = new DataView(this.data);
    this.ubuf = d.createBuffer({ size: this.lay.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const F = GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: F, buffer: {} },
      { binding: 1, visibility: F, buffer: {} },
      { binding: 2, visibility: F, sampler: {} },
      { binding: 3, visibility: F, sampler: {} },
      { binding: 4, visibility: F, sampler: { type: 'non-filtering' } },
    ];
    for (let i = 0; i < this.nIn; i++) entries.push({ binding: 5 + i, visibility: F, texture: {} });
    this.bgl = d.createBindGroupLayout({ entries });
    const intOut = format === 'rgba16uint';
    const module = d.createShaderModule({ code: buildSource(decl, intOut), label });
    this.pipeline = d.createRenderPipeline({
      label,
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** Compile and report WGSL diagnostics without throwing (used by the live shader op). */
  static async diagnose(gpu: Gpu, decl: PassDecl): Promise<string | null> {
    const src = buildSource(decl);
    const mod = gpu.device.createShaderModule({ code: src });
    const info = await mod.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (!errs.length) return null;
    const bodyStart = src.slice(0, src.indexOf('// ---- op ----')).split('\n').length;
    return errs.map(m => `line ${Math.max(1, m.lineNum - bodyStart)}: ${m.message}`).join('\n');
  }

  run(target: GPUTextureView, texs: (GPUTextureView | null)[], vals: Vals, res: [number, number], opts?: RunOpts) {
    const { gpu } = this;
    const d = gpu.device;
    const g = gpu.gdata;
    g[0] = res[0]; g[1] = res[1]; g[7] = res[0] / res[1];
    d.queue.writeBuffer(gpu.gbuf, 0, g);
    const v: Record<string, any> = { ...vals };
    for (let i = 0; i < this.nIn; i++) v[`has_${this.inputs[i]}`] = texs[i] ? 1 : 0;
    writeUniforms(this.lay, this.dv, v);
    d.queue.writeBuffer(this.ubuf, 0, this.data);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: gpu.gbuf } },
      { binding: 1, resource: { buffer: this.ubuf } },
      { binding: 2, resource: gpu.smp },
      { binding: 3, resource: gpu.smpR },
      { binding: 4, resource: gpu.smpN },
    ];
    for (let i = 0; i < this.nIn; i++) entries.push({ binding: 5 + i, resource: texs[i] ?? gpu.black });
    const bg = d.createBindGroup({ layout: this.bgl, entries });
    const enc = d.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: opts?.load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    if (opts?.viewport) rp.setViewport(...opts.viewport, 0, 1);
    rp.setPipeline(this.pipeline);
    rp.setBindGroup(0, bg);
    rp.draw(3);
    rp.end();
    d.queue.submit([enc.finish()]);
  }

  destroy() { this.ubuf.destroy(); }
}
