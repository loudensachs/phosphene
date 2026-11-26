// NERVE — MIDI input. Controller and note values are readable in any expression as cc(n) and note(n).
export class Midi {
  /** Controller values 0..1 by CC number (any channel). */
  cc = new Float32Array(128);
  /** Note velocities 0..1 by note number; 0 when released. */
  note = new Float32Array(128);
  devices: string[] = [];
  available = false;
  /** Most recently moved controller, for MIDI learn. */
  last: { cc: number; at: number } | null = null;
  private learn: ((cc: number) => void) | null = null;
  /** When each controller last moved (ms), so a live move can take over from a recorded take. */
  ccAt = new Float64Array(128);
  /** Tap for the performance recorder: kind 'cc' | 'on' | 'off'. */
  onEvent: ((kind: string, a: number, b: number) => void) | null = null;
  /** Latest OSC arguments by address. Expressions read them as osc.some.address (for /some/address). */
  osc = new Map<string, number[]>();
  oscPort = 0;
  oscLast: { addr: string; at: number } | null = null;
  onOsc(msgs: [string, number[]][]) { for (const [a, v] of msgs) { this.osc.set(a, v); this.oscLast = { addr: a, at: performance.now() }; } }
  oscValue(addr: string, index = 0) { return this.osc.get(addr)?.[index] ?? 0; }

  async init() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const acc = await navigator.requestMIDIAccess();
      const hook = () => {
        this.devices = [];
        acc.inputs.forEach(i => { this.devices.push(i.name ?? 'MIDI device'); i.onmidimessage = e => this.on(e.data); });
      };
      hook();
      acc.onstatechange = hook;
      this.available = true;
    } catch { this.available = false; }
  }

  private on(d: Uint8Array | null) {
    if (!d || d.length < 2) return;
    const st = d[0] & 0xf0;
    if (st === 0xb0) {
      this.cc[d[1] & 127] = d[2] / 127; this.ccAt[d[1] & 127] = performance.now(); this.onEvent?.('cc', d[1] & 127, d[2] / 127);
      this.last = { cc: d[1] & 127, at: performance.now() };
      if (this.learn) { const f = this.learn; this.learn = null; f(d[1] & 127); }
    } else if (st === 0x90) { this.note[d[1] & 127] = d[2] / 127; this.onEvent?.(d[2] ? 'on' : 'off', d[1] & 127, d[2] / 127); }
    else if (st === 0x80) { this.note[d[1] & 127] = 0; this.onEvent?.('off', d[1] & 127, 0); }
  }

  /** Resolve with the next controller that moves. Returns a cancel function. */
  learnNext(cb: (cc: number) => void) { this.learn = cb; return () => { this.learn = null; }; }
}
