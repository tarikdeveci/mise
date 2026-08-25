import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable,
  StyleSheet, Text, View, type ViewStyle,
} from 'react-native';
import {
  bandStyle, color, methodStyle, motion, numeric, radius, space, type,
  type ConfidenceBand, type PortionMethod,
} from '../theme';

/** Ease-out-expo. React Native's Easing has no `expo` preset. */
const EASE_OUT_EXPO = Easing.bezier(0.16, 1, 0.3, 1);

/** Honours the OS "reduce motion" setting for every animation in the app. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduced(v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; sub.remove(); };
  }, []);
  return reduced;
}

/* ─────────────────────────────── Button ─────────────────────────── */

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

export function Button({ label, onPress, variant = 'primary', loading, disabled, style }: ButtonProps) {
  const inert = Boolean(disabled ?? loading);
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy: Boolean(loading) }}
      style={({ pressed }) => [
        s.btn,
        variant === 'primary' && { backgroundColor: pressed ? color.signalDim : color.signal },
        variant === 'secondary' && {
          backgroundColor: pressed ? color.raised : color.surface,
          borderWidth: 1, borderColor: color.line,
        },
        variant === 'ghost' && { backgroundColor: pressed ? color.surface : 'transparent' },
        // An unavailable action should recede, not sit there as a dimmed slab.
        inert && !loading && { backgroundColor: color.surface, borderWidth: 0 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? color.onSignal : color.signal} size="small" />
      ) : (
        <Text
          style={[
            type.bodyStrong,
            { color: inert ? color.inkFaint : variant === 'primary' ? color.onSignal : color.ink },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/* ──────────────────────────────── Chips ─────────────────────────── */

export function BandChip({ band, label }: { band: ConfidenceBand; label?: string }) {
  const st = bandStyle[band];
  return (
    <View style={[s.chip, st.emphasis && s.chipEmphasis]}>
      <View style={[s.dot, { backgroundColor: st.dot }]} />
      <Text style={[type.label, { color: st.fg }]} numberOfLines={1}>{label ?? st.label}</Text>
    </View>
  );
}

/**
 * Which rung of the portion ladder produced this number.
 *
 * A mass off a scanned label and a mass a model guessed from pixels are
 * different kinds of claim. Showing the route, and the error the published work
 * associates with it, is what lets someone decide how much to trust the figure
 * instead of taking all of them as equally solid.
 */
export function MethodChip({
  method, min, likely, max,
}: { method: PortionMethod; min: number; likely: number; max: number }) {
  const st = methodStyle[method];
  // Derived, not quoted: the same rung is tight for "2 slices" and wide for a
  // bare mention, and a canned figure would contradict the number beside it.
  const pct = likely > 0 ? Math.round(((max - min) / (2 * likely)) * 100) : 0;
  return (
    <View style={[s.method, st.exact && s.methodExact]}>
      <Text style={[type.label, { color: st.exact ? color.ok : color.inkFaint }]} numberOfLines={1}>
        {st.label}{pct > 0 ? `  ±${pct}%` : ''}
      </Text>
    </View>
  );
}

/** A tappable answer to a clarification question. One tap, no modal, no form. */
export function ChoiceChip({
  label, onPress, selected, disabled,
}: { label: string; onPress: () => void; selected?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        s.choice,
        { backgroundColor: selected ? color.signal : pressed ? color.raised : 'transparent' },
        { borderColor: selected ? color.signal : color.lineStrong },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[type.smallStrong, { color: selected ? color.onSignal : color.ink }]}>{label}</Text>
    </Pressable>
  );
}

/* ─────────────────────────────── Gauge ──────────────────────────── */

interface RangeProps { min: number; likely: number; max: number }

/**
 * The uncertainty gauge.
 *
 * Every competitor prints one calorie figure to the unit, which is precision
 * the evidence cannot support: dietitians average ~41% error estimating
 * portions by eye, and no camera sees the oil in the pan. The number stays,
 * because people need something to act on; this shows how much room it has.
 *
 * Drawn as a scale, not a progress bar. An earlier version animated a fill to
 * full width, which made a span of uncertainty read as a task that had
 * finished.
 */
export function Gauge({ min, likely, max }: RangeProps) {
  const reduced = useReducedMotion();
  const slide = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  const span = Math.max(max - min, 0.0001);
  const markerPct = Math.min(100, Math.max(0, ((likely - min) / span) * 100));
  // A zero-wide range at zero calories is not an exact measurement, it is a
  // log with nothing in it. Both collapse to the same arithmetic, so the label
  // has to tell them apart — "EXACT" over an empty meal claims the one kind of
  // certainty this app exists not to fake.
  const empty = max <= 0;
  const flat = !empty && max - min < 0.5;

  useEffect(() => {
    if (reduced) { slide.setValue(1); return; }
    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1, duration: motion.slow, easing: EASE_OUT_EXPO, useNativeDriver: false,
    }).start();
  }, [slide, reduced, min, max, likely]);

  const left = slide.interpolate({ inputRange: [0, 1], outputRange: ['50%', `${markerPct}%`] });

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={empty
        ? 'No foods matched yet, so there is nothing to total'
        : `${Math.round(likely)} kcal, between ${Math.round(min)} and ${Math.round(max)}`}
    >
      <View style={s.gaugeTrack}>
        {[0, 25, 50, 75, 100].map((pct) => (
          <View key={pct} style={[s.tick, { left: `${pct}%` }, pct === 100 && { marginLeft: -2 }]} />
        ))}
        {!flat && <Animated.View style={[s.needle, { left }]} />}
      </View>
      <View style={s.gaugeLabels}>
        <Text style={[type.label, numeric, { color: color.inkMuted }]}>{Math.round(min)}</Text>
        <Text style={[type.label, { color: color.inkFaint, letterSpacing: 0.8 }]}>
          {empty ? 'NOT MATCHED' : flat ? 'EXACT' : 'RANGE'}
        </Text>
        <Text style={[type.label, numeric, { color: color.inkMuted }]}>{Math.round(max)}</Text>
      </View>
    </View>
  );
}

/** The list-row version: same idea, quiet enough to sit under a food name. */
export function MiniRange({ min, likely, max }: RangeProps) {
  const span = Math.max(max - min, 0.0001);
  const markerPct = Math.min(100, Math.max(0, ((likely - min) / span) * 100));
  const flat = max - min < 0.5;
  return (
    <View
      style={s.miniTrack}
      accessibilityRole="progressbar"
      accessibilityLabel={`between ${Math.round(min)} and ${Math.round(max)} kcal`}
    >
      {!flat && <View style={[s.miniNeedle, { left: `${markerPct}%` }]} />}
    </View>
  );
}

/* ───────────────────────────── Skeleton ─────────────────────────── */

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | `${number}%` }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    if (reduced) { pulse.setValue(0.6); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 620, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 620, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [pulse, reduced]);

  return (
    <Animated.View
      accessibilityElementsHidden
      style={{ height, width, borderRadius: radius.sm, backgroundColor: color.surface, opacity: pulse }}
    />
  );
}

export function Divider() { return <View style={s.divider} />; }

const s = StyleSheet.create({
  btn: {
    minHeight: 54,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, flexShrink: 0 },
  chipEmphasis: {
    paddingVertical: 4,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: color.raised,
  },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  method: {
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
  },
  // An exact rung earns a visible edge: it is a different kind of claim.
  methodExact: { backgroundColor: color.raised, borderWidth: 1, borderColor: color.line },
  choice: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
  },

  gaugeTrack: {
    height: 26,
    borderRadius: 4,
    backgroundColor: color.bg,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tick: {
    position: 'absolute',
    width: 2, height: 8, marginLeft: -1,
    borderRadius: 1,
    backgroundColor: color.signalDim,
    alignSelf: 'center',
  },
  needle: {
    position: 'absolute',
    width: 4, height: 26, marginLeft: -2,
    borderRadius: 1,
    backgroundColor: color.signal,
  },
  gaugeLabels: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: space.sm,
  },

  miniTrack: { height: 4, borderRadius: 2, backgroundColor: color.line, justifyContent: 'center' },
  miniNeedle: {
    position: 'absolute',
    width: 3, height: 8, marginLeft: -1.5,
    borderRadius: 1.5,
    backgroundColor: color.signal,
  },

  divider: { height: 1, backgroundColor: color.line },
});
