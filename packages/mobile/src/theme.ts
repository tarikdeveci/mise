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
 * Typeface.
 *
 * The system font was the single loudest generic signal in the first pass:
 * Roboto on Android, SF on iOS, no personality either way. IBM Plex was drawn
 * for engineering and technical documentation, which is exactly this product's
 * register, and the mono cut gives the readout the feel of an instrument
 * display rather than a heading.
 *
 * Two families, paired on a real contrast axis (grotesque + mono) rather than
 * two sans faces that merely differ. React Native does not synthesise weights
 * for custom fonts, so each step names its own family instead of a fontWeight.
 */
export const font = {
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  bold: 'IBMPlexSans_700Bold',
  monoMedium: 'IBMPlexMono_500Medium',
  monoBold: 'IBMPlexMono_600SemiBold',
} as const;

/**
 * Fixed scale, steps ~1.3 apart, with family doing the weight work.
 *
 * The first pass ran everything between 12 and 34 px at similar weights, which
 * is why the screen read as a form: no element was allowed to matter more than
 * any other.
 */
export const type = {
  /** The measured number, in mono. Nothing else comes close, on purpose. */
  readout: { fontFamily: font.monoBold, fontSize: 58, lineHeight: 62, letterSpacing: -2.6 },
  display: { fontFamily: font.bold, fontSize: 30, lineHeight: 34, letterSpacing: -0.9 },
  title: { fontFamily: font.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.5 },
  heading: { fontFamily: font.semibold, fontSize: 17, lineHeight: 23, letterSpacing: -0.2 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
  bodyStrong: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, letterSpacing: -0.1 },
  small: { fontFamily: font.regular, fontSize: 14, lineHeight: 21 },
  smallStrong: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20 },
  label: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, letterSpacing: 0.3 },
  /** Data: masses, calories, anything read as a measurement. */
  mono: { fontFamily: font.monoMedium, fontSize: 14, lineHeight: 20 },
  monoStrong: { fontFamily: font.monoBold, fontSize: 16, lineHeight: 22, letterSpacing: -0.3 },
} as const;

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
