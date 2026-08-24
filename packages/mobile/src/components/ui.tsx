import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable,
  StyleSheet, Text, View, type ViewStyle,
} from 'react-native';
import { bandStyle, color, motion, radius, space, type, type ConfidenceBand } from '../theme';

/**
 * Ease-out-expo. React Native's Easing has no `quart`/`expo` preset, so the
 * curve is spelled out once here rather than approximated per-call with
 * whatever preset happens to be available.
 */
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

/** Every state the register requires: default, pressed, disabled, loading. */
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
        variant === 'primary' && { backgroundColor: pressed ? color.primaryPressed : color.primary },
        variant === 'secondary' && {
          backgroundColor: pressed ? color.surfaceSunk : color.surface,
          borderWidth: 1, borderColor: color.border,
        },
        variant === 'ghost' && { backgroundColor: pressed ? color.surfaceSunk : 'transparent' },
        inert && { opacity: 0.45 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : color.primary} size="small" />
      ) : (
        <Text style={[type.bodyStrong, { color: variant === 'primary' ? '#fff' : color.ink }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/* ──────────────────────────────── Chip ──────────────────────────── */

export function BandChip({ band, label }: { band: ConfidenceBand; label?: string }) {
  const st = bandStyle[band];
  return (
    <View style={[s.chip, { backgroundColor: st.bg }]}>
      <View style={[s.dot, { backgroundColor: st.dot }]} />
      <Text style={[type.label, { color: st.fg }]} numberOfLines={1}>
        {label ?? st.label}
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
        { backgroundColor: selected ? color.primary : pressed ? color.primarySoft : color.bg },
        { borderColor: selected ? color.primary : color.borderStrong },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[type.smallStrong, { color: selected ? '#fff' : color.ink }]}>{label}</Text>
    </Pressable>
  );
}

/* ────────────────────────────── RangeBar ────────────────────────── */

/**
 * The uncertainty band.
 *
 * This is the most important component in the app. Every competitor prints a
 * single calorie figure to the unit — "537 kcal" — which is precision the
 * evidence cannot support: trained dietitians average ~41% error estimating
 * portions by eye, and a camera cannot see the oil in the pan.
 *
 * So the headline number stays (people need something to act on) but the band
 * underneath shows how much room the estimate really has, sized to the actual
 * interval rather than a decorative fixed width. A wide band is not a defect
 * to hide; it is the app saying which numbers to trust.
 */
export function RangeBar({
  min, likely, max, unit = 'kcal', compact,
}: { min: number; likely: number; max: number; unit?: string; compact?: boolean }) {
  const reduced = useReducedMotion();
  const grow = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  const span = Math.max(max - min, 0.0001);
  const markerPct = Math.min(100, Math.max(0, ((likely - min) / span) * 100));

  useEffect(() => {
    if (reduced) { grow.setValue(1); return; }
    Animated.timing(grow, {
      toValue: 1,
      duration: motion.slow,
      easing: EASE_OUT_EXPO,
      useNativeDriver: false,
    }).start();
  }, [grow, reduced, min, max, likely]);

  const width = grow.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`${Math.round(likely)} ${unit}, between ${Math.round(min)} and ${Math.round(max)}`}
    >
      <View style={[s.track, compact && { height: 6 }]}>
        <Animated.View style={[s.fill, compact && { height: 6 }, { width }]}>
          <View style={[s.marker, compact && { height: 6, width: 2 }, { left: `${markerPct}%` }]} />
        </Animated.View>
      </View>
      {!compact && (
        <View style={s.rangeLabels}>
          <Text style={[type.label, { color: color.inkFaint }]}>{Math.round(min)}</Text>
          <Text style={[type.label, { color: color.inkFaint }]}>{Math.round(max)}</Text>
        </View>
      )}
    </View>
  );
}

/* ───────────────────────────── Skeleton ─────────────────────────── */

/** Skeletons, not a spinner dropped in the middle of the content. */
export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | `${number}%` }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (reduced) { pulse.setValue(0.7); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 620, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 620, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [pulse, reduced]);

  return (
    <Animated.View
      accessibilityElementsHidden
      style={{ height, width, borderRadius: radius.sm, backgroundColor: color.surfaceSunk, opacity: pulse }}
    />
  );
}

/* ──────────────────────────── primitives ────────────────────────── */

export function Panel({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.panel, style]}>{children}</View>;
}

export function Divider() {
  return <View style={s.divider} />;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={[type.label, { color: color.inkMuted }]}>{children}</Text>;
}

const s = StyleSheet.create({
  btn: {
    minHeight: 50,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingVertical: 5,
    paddingHorizontal: space.md - 2,
    borderRadius: radius.pill,
    // Never compress: sharing a row with a flex:1 range bar was truncating the
    // label to "Worth a", which reads as a rendering bug rather than a state.
    flexShrink: 0,
  },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  choice: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  track: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunk,
    overflow: 'hidden',
  },
  fill: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.primarySoft,
    justifyContent: 'center',
  },
  marker: {
    position: 'absolute',
    width: 3,
    height: 10,
    marginLeft: -1.5,
    borderRadius: 2,
    backgroundColor: color.primary,
  },
  rangeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.xs + 1,
  },
  panel: {
    backgroundColor: color.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    padding: space.lg,
  },
  divider: { height: 1, backgroundColor: color.border },
});
