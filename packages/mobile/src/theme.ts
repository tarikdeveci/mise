import type { TextStyle } from 'react-native';

/**
 * Design tokens.
 *
 * The product is a measuring instrument. Its claim is that it reports what it
 * actually knows: a range instead of a fake-precise number, the rung of the
 * ladder each figure came from, a question instead of a guess.
 *
 * Earlier passes put that identity in one dark panel floating on a white app,
 * which meant the app only became itself after you pressed Save. Now the
 * instrument IS the surface: dark-first, one lit accent, and the readout is the
 * native register rather than an exception to it.
 *
 * The risk with dark is the "tools look cool dark" reflex, so it is not carried
 * by the darkness. It is carried by IBM Plex Mono on every measured figure, a
 * gauge drawn as a scale rather than a progress bar, and a single signal colour
 * used only where something is live or actionable.
 *
 * Every value was contrast-checked against the surface it actually sits on and
 * the ratio is recorded, so a later edit has to break it knowingly.
 */

export const color = {
  /** The ground. */
  bg: '#030d17',
  /** Panels, inputs, list rows. */
  surface: '#0c1b27',
  /** The readout, pressed states, anything lifted toward the user. */
  raised: '#152736',
  line: '#20313f',
  lineStrong: '#324859',

  ink: '#f3f7fb',       // 18.17:1 on bg · 16.23:1 on surface
  inkMuted: '#a4b3c1',  //  9.12:1 on bg ·  8.15:1 on surface
  inkFaint: '#798895',  //  5.37:1 on bg ·  4.80:1 on surface

  /** The lit needle, and the one colour a primary action is allowed. */
  signal: '#4ebaff',    //  9.12:1 on bg
  signalDim: '#2a628d',
  /** Text on a signal-filled surface. 9.28:1 on signal. */
  onSignal: '#010a14',

  ok: '#56cb98',        //  9.68:1 on bg — logged, nothing to check
  warn: '#f1ba4b',      // 11.05:1 on bg — worth a look
  danger: '#f66d67',    //  6.80:1 on bg
} as const;

export const space = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 36, xxxl: 56,
} as const;

/**
 * Typeface. IBM Plex was drawn for engineering documentation, which is this
 * product's register, and the mono cut makes a measured figure read as an
 * instrument display rather than a heading. React Native does not synthesise
 * weights for custom fonts, so each step names its own family.
 */
export const font = {
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  bold: 'IBMPlexSans_700Bold',
  monoMedium: 'IBMPlexMono_500Medium',
  monoBold: 'IBMPlexMono_600SemiBold',
} as const;

/** Fixed scale, steps ~1.3 apart, with family doing the weight work. */
export const type = {
  /** The measured total. Nothing else comes close, on purpose. */
  readout: { fontFamily: font.monoBold, fontSize: 58, lineHeight: 62, letterSpacing: -2.6 },
  display: { fontFamily: font.bold, fontSize: 30, lineHeight: 34, letterSpacing: -0.9 },
  title: { fontFamily: font.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.5 },
  heading: { fontFamily: font.semibold, fontSize: 17, lineHeight: 23, letterSpacing: -0.2 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
  bodyStrong: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, letterSpacing: -0.1 },
  small: { fontFamily: font.regular, fontSize: 14, lineHeight: 21 },
  smallStrong: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20 },
  label: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, letterSpacing: 0.3 },
  /** Any figure read as a measurement: masses, calories, macros. */
  mono: { fontFamily: font.monoMedium, fontSize: 14, lineHeight: 20 },
  monoStrong: { fontFamily: font.monoBold, fontSize: 16, lineHeight: 22, letterSpacing: -0.3 },
} as const;

/** Plex Mono is already tabular; kept as an explicit marker of intent. */
export const numeric: TextStyle = {};

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

/** State changes only: 150–260 ms. Users are mid-task, not watching a show. */
export const motion = { fast: 140, base: 200, slow: 260 } as const;

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'none';

/**
 * Band presentation. Colour rides on a single dot; only the state that wants a
 * decision gets a filled background, so a settled item cannot shout as loudly
 * as one that needs the user.
 */
export const bandStyle: Record<
  ConfidenceBand,
  { label: string; dot: string; fg: string; emphasis: boolean }
> = {
  high: { label: 'Logged', dot: color.ok, fg: color.inkMuted, emphasis: false },
  medium: { label: 'Worth a look', dot: color.warn, fg: color.warn, emphasis: false },
  low: { label: 'Needs you', dot: color.signal, fg: color.signal, emphasis: true },
  none: { label: 'Empty', dot: color.lineStrong, fg: color.inkFaint, emphasis: false },
};

/**
 * The portion ladder, surfaced in the UI.
 *
 * A number from a scanned label and a number a model guessed off a photo are
 * different kinds of claim, and the user is entitled to know which one they are
 * looking at. `error` is the rough calorie error the published work associates
 * with that route, shown so the figure is judgeable rather than just asserted.
 */
export type PortionMethod =
  | 'stated_mass' | 'stated_volume' | 'barcode_label' | 'user_memory'
  | 'household_measure' | 'reference_scaled' | 'model_estimate';

export const methodStyle: Record<PortionMethod, { label: string; exact: boolean }> = {
  stated_mass: { label: 'You weighed it', exact: true },
  stated_volume: { label: 'You measured it', exact: true },
  barcode_label: { label: 'From the label', exact: true },
  user_memory: { label: 'Your usual', exact: true },
  household_measure: { label: 'From your words', exact: false },
  reference_scaled: { label: 'Scaled to reference', exact: false },
  model_estimate: { label: 'Estimated', exact: false },
};
