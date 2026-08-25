import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { LoggedItem } from '../api';
import { color, numeric, radius, space, type } from '../theme';
import { Button, ChoiceChip } from './ui';

/**
 * The amount control.
 *
 * The app has always shown a range and never let anyone move it, which reads as
 * an instrument with the dial glued down: it tells you it is unsure, offers a
 * span, and then refuses the one piece of information that would close it — the
 * number the person who ate the food actually knows.
 *
 * So the range is the control now. Both ends of it are one tap away, because
 * "it was nearer the top of that" is the commonest correction and it should not
 * require arithmetic. Underneath is a plain gram field for the people who
 * weighed it, and the calorie figure moves as you type, so the trade between
 * grams and kcal is visible while you are deciding rather than after you commit.
 *
 * Offered on every resolved item, including ones whose amount the user stated in
 * words. A typed "150 g" used to be uneditable — the top rung of the portion
 * ladder wins by design, so the correction was recorded and then ignored.
 */

/** Matches the server's guard. A slipped digit is a typo, not an appetite. */
const MAX_GRAMS = 5000;

interface Props {
  item: LoggedItem;
  busy?: boolean;
  onSet: (grams: number) => void;
}

/** Trailing ".0" is noise on a mass; a real ".5" is not. */
const show = (n: number): string => String(Number(n.toFixed(1)));

/** Coarse enough to be worth tapping, fine enough not to overshoot. */
function stepFor(grams: number): number {
  if (grams < 50) return 5;
  if (grams < 200) return 10;
  if (grams < 600) return 25;
  return 50;
}

export function PortionEditor({ item, busy, onSet }: Props) {
  const portion = item.portion;
  const current = portion?.gramsLikely ?? 0;
  const [draft, setDraft] = useState(() => show(current));

  // A saved correction comes back as a new item, so the field follows the
  // number rather than holding the value the user has already committed.
  useEffect(() => { setDraft(show(current)); }, [current]);

  if (!portion || !item.nutrition || !item.foodId) return null;

  const grams = Number(draft.replace(',', '.'));
  const valid = Number.isFinite(grams) && grams > 0 && grams <= MAX_GRAMS;
  const changed = valid && Math.abs(grams - current) >= 0.05;

  // The arithmetic the server does, done locally so the preview cannot claim a
  // figure the server would not produce: every nutrient scales linearly with
  // mass, so one ratio is the whole model.
  const kcalPerGram = current > 0 ? item.nutrition.likely.kcal / current : 0;
  const preview = Math.round(kcalPerGram * (valid ? grams : current));
  const delta = preview - Math.round(item.nutrition.likely.kcal);

  const nudge = (direction: 1 | -1): void => {
    const from = valid ? grams : current;
    const next = Math.max(1, Math.min(MAX_GRAMS, from + direction * stepFor(from)));
    setDraft(show(Math.round(next)));
  };

  /** Round ends of the range, plus the usual halving and doubling. */
  const shortcuts = [
    { label: 'Low', grams: portion.gramsMin },
    { label: 'High', grams: portion.gramsMax },
    { label: '½', grams: current / 2 },
    { label: '2×', grams: current * 2 },
  ]
    .map((s) => ({ ...s, grams: Math.round(s.grams) }))
    .filter((s, at, all) =>
      s.grams > 0 && s.grams <= MAX_GRAMS
      && s.grams !== Math.round(current)
      && all.findIndex((o) => o.grams === s.grams) === at);

  return (
    <View style={s.wrap}>
      <Text style={[type.smallStrong, { color: color.ink }]}>Amount</Text>

      <View style={s.row}>
        <Nudge label="−" onPress={() => { nudge(-1); }} disabled={busy} />
        <View style={[s.field, !valid && s.fieldBad]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            keyboardType="numeric"
            inputMode="decimal"
            selectTextOnFocus
            editable={!busy}
            accessibilityLabel="Amount in grams"
            style={[type.monoStrong, numeric, s.input, { color: valid ? color.ink : color.danger }]}
            placeholderTextColor={color.inkFaint}
          />
          <Text style={[type.label, { color: color.inkFaint }]}>g</Text>
        </View>
        <Nudge label="+" onPress={() => { nudge(1); }} disabled={busy} />

        <View style={s.preview}>
          <Text style={[type.monoStrong, numeric, { color: changed ? color.signal : color.inkMuted }]}>
            {valid ? preview : '—'}
            <Text style={[type.label, { color: color.inkFaint }]}> kcal</Text>
          </Text>
          {changed && delta !== 0 && (
            <Text style={[type.label, numeric, { color: color.inkFaint }]}>
              {delta > 0 ? '+' : ''}{delta}
            </Text>
          )}
        </View>
      </View>

      {shortcuts.length > 0 && (
        <View style={s.shortcuts}>
          {shortcuts.map((shortcut) => (
            <ChoiceChip
              key={shortcut.label}
              label={`${shortcut.label} · ${shortcut.grams} g`}
              disabled={busy}
              onPress={() => { setDraft(String(shortcut.grams)); }}
            />
          ))}
        </View>
      )}

      <Button
        label={changed ? `Set to ${show(grams)} g` : 'Amount unchanged'}
        variant={changed ? 'primary' : 'secondary'}
        disabled={!changed || busy}
        onPress={() => { onSet(Number(grams.toFixed(1))); }}
        style={{ marginTop: space.md, minHeight: 46 }}
      />

      <Text style={[type.small, { color: color.inkFaint, marginTop: space.sm }]}>
        {valid
          ? `mise remembers this for “${item.extracted.phrase}” and stops estimating.`
          : `Enter a mass between 1 and ${MAX_GRAMS} g.`}
      </Text>
    </View>
  );
}

function Nudge({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label === '+' ? 'Increase amount' : 'Decrease amount'}
      hitSlop={6}
      style={({ pressed }) => [
        s.nudge,
        { backgroundColor: pressed ? color.raised : color.surface },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[type.title, { color: color.ink, lineHeight: 26 }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  nudge: {
    width: 44, height: 44,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: color.line,
    alignItems: 'center', justifyContent: 'center',
  },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    height: 44, minWidth: 86,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.raised,
    borderWidth: 1, borderColor: color.line,
  },
  fieldBad: { borderColor: color.danger },
  // Android pads text inputs generously by default, which knocks the figure off
  // the baseline of the buttons either side of it.
  input: { flex: 1, padding: 0, textAlign: 'center', minWidth: 46 },
  preview: { flex: 1, alignItems: 'flex-end' },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
});
