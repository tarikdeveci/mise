import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable,
  StyleSheet, Text, View, type ViewStyle,
} from 'react-native';
import { bandStyle, color, motion, numeric, radius, space, type, type ConfidenceBand } from '../theme';

/**
 * Ease-out-expo. React Native's Easing has no `quart`/`expo` preset, so the
 * curve is spelled out once here rather than approximated per call.
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
        variant === 'primary' && { backgroundColor: pressed ? color.readoutEdge : color.readout },
        variant === 'secondary' && {
          backgroundColor: pressed ? color.surfaceSunk : color.bg,
          borderWidth: 1.5, borderColor: color.border,
        },
        variant === 'ghost' && { backgroundColor: pressed ? color.surfaceSunk : 'transparent' },
        // A disabled dark button dimmed by opacity becomes a heavy grey slab
        // that still dominates the screen while doing nothing. Unavailable
        // actions should recede, so it drops to a flat surface fill instead.
        inert && !loading && { backgroundColor: color.surfaceSunk, borderWidth: 0 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? color.signal : color.primary} size="small" />
      ) : (
        <Text
          style={[
            type.bodyStrong,
            { color: inert ? color.inkFaint : variant === 'primary' ? color.readoutInk : color.ink },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/* ──────────────────────────────── Chip ──────────────────────────── */

/**
 * Confidence state.
 *
 * A dot plus a word. The previous pastel pill gave "Logged" and "Needs you"
 * identical visual weight, so a settled meal shouted as loudly as one that
 * actually wanted attention. Only `low` — the state that needs a decision — is
 * allowed a background.
 */
export function BandChip({ band, label }: { band: ConfidenceBand; label?: string }) {
  const st = bandStyle[band];
  return (
    <View style={[s.chip, st.emphasis && s.chipEmphasis]}>
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
        { backgroundColor: selected ? color.readout : pressed ? color.surfaceSunk : color.bg },
        { borderColor: selected ? color.readout : color.borderStrong },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[type.smallStrong, { color: selected ? color.readoutInk : color.ink }]}>{label}</Text>
    </Pressable>
  );
}

/* ─────────────────────────────── Gauge ──────────────────────────── */

interface RangeProps {
  min: number;
  likely: number;
  max: number;
}

/**
 * The uncertainty gauge — the most important component in the app.
 *
 * Every competitor prints one calorie figure to the unit. That is precision the
 * evidence cannot support: dietitians average ~41% error estimating portions by
 * eye, and no camera sees the oil in the pan. So the number stays (people need
 * something to act on) and this shows how much room it really has.
 *
 * It is drawn like an instrument scale rather than a progress bar, because a
 * progress bar reads as "how far along" and this is "how wide the doubt is".
 * The needle is the brightest thing on the panel; the earlier version rendered
 * the app's whole differentiator as a pale 10 px line nobody would look at.
 */
export function Gauge({ min, likely, max }: RangeProps) {
  const reduced = useReducedMotion();
  const slide = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  const span = Math.max(max - min, 0.0001);
  const markerPct = Math.min(100, Math.max(0, ((likely - min) / span) * 100));
  const flat = max - min < 0.5;

  useEffect(() => {
    if (reduced) { slide.setValue(1); return; }
    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1, duration: motion.slow, easing: EASE_OUT_EXPO, useNativeDriver: false,
    }).start();
  }, [slide, reduced, min, max, likely]);

  // The needle settles into place from the centre. Nothing "fills": there is no
  // progress here to be partway through, and an animated fill made a span of
  // uncertainty read as a task at 100% completion.
  const left = slide.interpolate({
    inputRange: [0, 1],
    outputRange: ['50%', `${markerPct}%`],
  });

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`${Math.round(likely)} kcal, between ${Math.round(min)} and ${Math.round(max)}`}
    >
      <View style={s.gaugeTrack}>
        {/* Ruler ticks: the track is a scale to read a value off, not a bar to
            fill. Five is enough to signal "measurement" without clutter. */}
        {[0, 25, 50, 75, 100].map((pct) => (
          <View key={pct} style={[s.tick, { left: `${pct}%` }, pct === 0 && { marginLeft: 0 },
            pct === 100 && { marginLeft: -2 }]} />
        ))}
        {!flat && <Animated.View style={[s.needle, { left }]} />}
      </View>
      <View style={s.gaugeLabels}>
        <Text style={[type.label, numeric, { color: color.readoutMuted }]}>{Math.round(min)}</Text>
        <Text style={[type.label, { color: color.readoutMuted, letterSpacing: 0.8 }]}>
          {flat ? 'EXACT' : 'RANGE'}
        </Text>
        <Text style={[type.label, numeric, { color: color.readoutMuted }]}>{Math.round(max)}</Text>
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

export function Divider() {
  return <View style={s.divider} />;
}

const s = StyleSheet.create({
  btn: {
    minHeight: 54,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    flexShrink: 0,
  },
  chipEmphasis: {
    paddingVertical: 4,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: color.primarySoft,
  },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
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
    backgroundColor: color.readoutTrack,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tick: {
    position: 'absolute',
    width: 2,
    height: 8,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: color.signalDim,
    alignSelf: 'center',
  },
  needle: {
    position: 'absolute',
    width: 4,
    height: 26,
    marginLeft: -2,
    borderRadius: 1,
    backgroundColor: color.signal,
  },
  gaugeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.sm,
  },

  miniTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: color.surfaceSunk,
    justifyContent: 'center',
  },
  miniNeedle: {
    position: 'absolute',
    width: 3,
    height: 8,
    marginLeft: -1.5,
    borderRadius: 1.5,
    backgroundColor: color.primary,
  },

  divider: { height: 1, backgroundColor: color.border },
});
