// Single-weight line icon set (16px grid, 1.35 stroke) so every glyph in the app shares one hand.
const P: Record<string, string> = {
  play: 'M5 3.2v9.6L12.6 8z',
  pause: 'M4.5 3.2h2.4v9.6H4.5zM9.1 3.2h2.4v9.6H9.1z',
  start: 'M3.6 3.2h1.6v9.6H3.6zM12.6 3.2v9.6L5.8 8z',
  loop: 'M3 7.2V6a2 2 0 0 1 2-2h6.4M9.8 2.2 11.6 4 9.8 5.8M13 8.8V10a2 2 0 0 1-2 2H4.6M6.2 13.8 4.4 12l1.8-1.8',
  import: 'M8 2v7.4M5.2 6.8 8 9.6l2.8-2.8M2.6 10.4v2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-2',
  export: 'M8 9.8V2.4M5.2 5 8 2.2 10.8 5M2.6 10.4v2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-2',
  plus: 'M8 3v10M3 8h10',
  target: 'M2.4 5.2V3.4a1 1 0 0 1 1-1h1.8M10.8 2.4h1.8a1 1 0 0 1 1 1v1.8M13.6 10.8v1.8a1 1 0 0 1-1 1h-1.8M5.2 13.6H3.4a1 1 0 0 1-1-1v-1.8M8 5.4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM5.6 11.2c.4-1.3 1.3-2 2.4-2s2 .7 2.4 2',
  monitor: 'M2.2 3.2h11.6v7.4H2.2zM5.6 13.2h4.8M8 10.6v2.6',
  network: 'M2 3.4h4v3.2H2zM10 9.4h4v3.2h-4zM10 2.6h4v3.2h-4zM6 5h1.6c1 0 1.2 6 2.4 6M6 5c1.6 0 2.4-.8 4-.8',
  sliders: 'M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M8.5 3v3h3V3zM4.5 10v3h3v-3z',
  eye: 'M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  film: 'M2.2 3h11.6v10H2.2zM5 3v10M11 3v10M2.2 6.4H5M2.2 9.6H5M11 6.4h2.8M11 9.6h2.8',
  curve: 'M2 12.5c3 0 3-9 6-9s3 9 6 9',
  bands: 'M2.5 13V8M5.5 13V4M8.5 13V6.5M11.5 13V3M14 13V9',
  sparkle: 'M7 2.2 8.3 6 12 7.3 8.3 8.6 7 12.4 5.7 8.6 2 7.3 5.7 6ZM12.4 10.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z',
  search: 'M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zM10.2 10.2l3.4 3.4',
  chevron: 'M5.6 3.6 10 8l-4.4 4.4',
  reset: 'M3.2 5.2h6a3.6 3.6 0 0 1 0 7.2H6M5.4 3 3.2 5.2l2.2 2.2',
  audio: 'M2.4 6.2h2.4L8 3.4v9.2L4.8 9.8H2.4zM10.4 5.8a3.2 3.2 0 0 1 0 4.4M12.2 4a5.8 5.8 0 0 1 0 8',
  layers: 'M8 2.2 14 5.4 8 8.6 2 5.4zM2.6 8.2 8 11l5.4-2.8M2.6 10.9 8 13.7l5.4-2.8',
  grid: 'M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11',
  mute: 'M2.4 6.2h2.4L8 3.4v9.2L4.8 9.8H2.4zM10.6 6l3.4 4M14 6l-3.4 4',
  close: 'M4 4l8 8M12 4l-8 8',
  cut: 'M4.2 3.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM4.2 9.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM5.6 5.6 13.4 12M5.6 10.4 13.4 4',
  frame: 'M2.4 5.4V2.6h2.8M10.8 2.6h2.8v2.8M13.6 10.6v2.8h-2.8M5.2 13.4H2.4v-2.8',
  bolt: 'M9 1.8 3.8 9h3.6L6.8 14.2 12.2 7H8.6z',
  globe: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zM2.2 8h11.6M8 2.2c-1.6 1.6-2.4 3.5-2.4 5.8s.8 4.2 2.4 5.8M8 2.2c1.6 1.6 2.4 3.5 2.4 5.8s-.8 4.2-2.4 5.8',
};
const FILLED = new Set(['play', 'pause', 'start', 'bolt']);

export function Icon({ n, size = 14 }: { n: keyof typeof P | string; size?: number }) {
  const filled = FILLED.has(n);
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[n] ?? ''} />
    </svg>
  );
}

/** Phosphene mark: a light and its afterimage. Matches the app icon. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <g transform="translate(-0.62 0.62)">
        <circle cx="9.9" cy="6.1" r="4.3" stroke="#f2b84b" strokeWidth="1.3" />
        <circle cx="6.1" cy="9.9" r="4.3" fill="#f2b84b" stroke="#0d0d0f" strokeWidth="1.2" />
      </g>
    </svg>
  );
}
