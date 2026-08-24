/**
 * Design tokens.
 *
 * Identity: this is an instrument, not a wellness app. The product's whole
 * claim is that it tells you what it actually knows — a range instead of a
 * fake-precise number, the source behind every figure, a question instead of a
 * guess. So the surface reads like a well-made measuring tool: cold cobalt,
 * true white, dense readable type, no decoration that isn't carrying state.
 *
 * Colours are authored in OKLCH and committed as hex because React Native does
 * not parse oklch(). Every value below was contrast-checked against its actual
 * background before being written down; the ratios are recorded so a later edit
 * has to knowingly break them rather than accidentally.
 */

export const color = {
  /** Pure white. Warmth belongs to the brand colour, not the surface. */
  bg: '#ffffff',
  surface: '#f3f6f8',
  surfaceSunk: '#edf1f4',

  ink: '#121c23',        // 17.27:1 on bg
  inkMuted: '#505d66',   //  6.78:1 on bg
  inkFaint: '#69757e',   //  4.72:1 on bg — placeholder-safe

  primary: '#0069ad',    //  5.79:1 on bg · white on it: 5.79:1
  primaryPressed: '#00579d',
  primarySoft: '#daeefe', // ink on it: 14.51:1

  /** High confidence: logged without asking. */
  confirmed: '#1c7b5a',
  confirmedSoft: '#daf2e6',

  /** Medium: logged, but worth a glance. */
  review: '#8a5900',     //  5.98:1 on bg
  reviewSoft: '#ffebce',

  /**
   * Low confidence is deliberately NOT red. Asking a question is the system
   * working correctly, not failing; colouring it like an error would teach
   * users to dread the honest path. Red stays reserved for real failures.
   */
  ask: '#0069ad',
  askSoft: '#daeefe',

  danger: '#be2f2c',

  border: '#dbdee1',
  borderStrong: '#b8bfc4',
} as const;

/** 4pt base. Uneven steps at the top so sections breathe differently. */
export const space = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 36, xxxl: 56,
} as const;

/**
 * Fixed scale, ratio ~1.2. Product UI is viewed at consistent DPI; fluid
 * headings that shrink inside a panel look worse, not more responsive.
 */
export const type = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 19, lineHeight: 25, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 23, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 23, fontWeight: '600' as const },
  small: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  smallStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  label: { fontSize: 12.5, lineHeight: 17, fontWeight: '600' as const },
  mono: { fontSize: 13, lineHeight: 19, fontWeight: '400' as const },
} as const;

export const radius = {
  sm: 6,
  /** Cards top out here. Anything rounder reads as decoration. */
  md: 10,
  lg: 14,
  pill: 999,
} as const;

/** State changes only: 150-250 ms. Users are mid-task, not watching a show. */
export const motion = { fast: 140, base: 190, slow: 240 } as const;

export const mono =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  typeof process !== 'undefined' && process.env.EXPO_OS === 'ios'
    ? 'Menlo'
    : 'monospace';

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'none';

/** One place that maps a band to how it looks and what it says. */
export const bandStyle: Record<
  ConfidenceBand,
  { label: string; fg: string; bg: string; dot: string }
> = {
  high: { label: 'Logged', fg: color.ink, bg: color.confirmedSoft, dot: color.confirmed },
  medium: { label: 'Worth a look', fg: color.ink, bg: color.reviewSoft, dot: color.review },
  low: { label: 'Needs you', fg: color.ink, bg: color.askSoft, dot: color.ask },
  none: { label: 'Empty', fg: color.inkMuted, bg: color.surfaceSunk, dot: color.borderStrong },
};
