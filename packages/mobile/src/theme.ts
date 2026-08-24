import type { TextStyle } from 'react-native';

/**
 * Design tokens.
 *
 * The product is an instrument, not a wellness app. Its entire claim is that it
 * reports what it actually knows: a range instead of a fake-precise number, the
 * source behind every figure, a question instead of a guess.
 *
 * So the app is built around one committed surface — a dark **readout panel**
 * that holds the number and its range, the way a scale or a meter does — with a
 * calm, light list underneath. Everything defers to that panel. A single
 * saturated surface carrying the identity is the "Committed" strategy applied
 * to exactly one place; the rest stays restrained so the readout keeps its
 * weight.
 *
 * Colours are authored in OKLCH and committed as hex because React Native does
 * not parse oklch(). Every value was contrast-checked against the background it
 * actually sits on, and the ratios are recorded so a later edit has to break
 * them knowingly rather than by accident.
 */

export const color = {
  bg: '#ffffff',
  surface: '#f3f6f8',
  surfaceSunk: '#edf1f4',

  ink: '#121c23',        // 17.27:1 on bg
  inkMuted: '#505d66',   //  6.78:1 on bg
  inkFaint: '#69757e',   //  4.72:1 on bg — placeholder-safe

  primary: '#0069ad',    //  5.79:1 on bg
  primaryPressed: '#00579d',
  primarySoft: '#daeefe',

  /* The readout: one dark, committed surface. */
  readout: '#061420',
  readoutEdge: '#132737',
  readoutInk: '#f8fafd',    // 17.79:1 on readout
  readoutMuted: '#a3b4c2',  //  8.74:1 on readout
  readoutTrack: '#1b3345',
  /** The lit needle. 8.68:1 on the panel, 6.10:1 on its own track. */
  signal: '#4ebaff',
  signalDim: '#306893',

  confirmed: '#1c7b5a',
  review: '#8a5900',     //  5.98:1 on bg
  /** Low confidence is not red: asking a question is the system working. */
  ask: '#0069ad',
  danger: '#be2f2c',

  border: '#e4e8eb',
  borderStrong: '#b8bfc4',
} as const;

export const space = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 36, xxxl: 56,
} as const;

/**
 * Fixed scale. Product UI is viewed at consistent DPI, so a fluid heading that
 * shrinks inside a panel looks worse, not more responsive.
 *
 * The steps are deliberately far apart (~1.3) and weight does as much work as
 * size. The previous scale ran everything between 12 and 34 px at similar
 * weights, which is why the screen read as a form: no element was allowed to be
 * more important than any other.
 */
export const type = {
  /** The measured number. Nothing else on screen comes close, on purpose. */
  readout: {
    fontSize: 60, lineHeight: 62, fontWeight: '800' as const, letterSpacing: -2.2,
  },
  display: { fontSize: 30, lineHeight: 34, fontWeight: '800' as const, letterSpacing: -0.9 },
  title: { fontSize: 22, lineHeight: 27, fontWeight: '700' as const, letterSpacing: -0.5 },
  heading: { fontSize: 17, lineHeight: 23, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const, letterSpacing: -0.1 },
  small: { fontSize: 14, lineHeight: 21, fontWeight: '400' as const },
  smallStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.2 },
} as const;

/**
 * Tabular figures for anything numeric.
 *
 * Proportional digits make a column of calorie counts jitter as values change,
 * which is precisely the impression a measuring instrument must not give.
 */
export const numeric: TextStyle = { fontVariant: ['tabular-nums'] };

export const radius = {
  sm: 6,
  md: 10,
  /** Cards top out here; the readout panel is the only thing this round. */
  lg: 16,
  pill: 999,
} as const;

/** State changes only: 150–260 ms. Users are mid-task, not watching a show. */
export const motion = { fast: 140, base: 200, slow: 260 } as const;

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'none';

/**
 * Band presentation.
 *
 * The pastel pill is gone. It gave three states the same visual weight and made
 * a settled item shout as loudly as one needing attention. Now colour is
 * carried by a single dot, and only the states that actually want the user's
 * attention get a tinted background.
 */
export const bandStyle: Record<
  ConfidenceBand,
  { label: string; dot: string; fg: string; emphasis: boolean }
> = {
  high: { label: 'Logged', dot: color.confirmed, fg: color.inkMuted, emphasis: false },
  medium: { label: 'Worth a look', dot: color.review, fg: color.review, emphasis: false },
  low: { label: 'Needs you', dot: color.ask, fg: color.primary, emphasis: true },
  none: { label: 'Empty', dot: color.borderStrong, fg: color.inkFaint, emphasis: false },
};
