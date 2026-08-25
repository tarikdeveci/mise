import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, numeric, radius, space, type } from '../theme';
import { FoodPicker } from './FoodPicker';
import { Button } from './ui';

/**
 * Adds a food the meal was logged without.
 *
 * Every other control on the results screen edits something already on the
 * list: change the food, move the amount, answer a question about a line. None
 * of them can say "there was also a glass of ayran", and a photo that reads
 * four items off a plate of five is the commonest way this happens. Until this
 * existed the only way to record the fifth was to log the whole meal a second
 * time, which loses the photograph and every correction already made to it.
 *
 * Collapsed by default. The screen's job is to show what was logged, and a
 * permanently open search field would put a text box above the numbers on
 * every meal that had nothing missing at all — which is most of them.
 */

/** Matches the server's guard. A slipped digit is a typo, not an appetite. */
const MAX_GRAMS = 5000;

interface Props {
  busy?: boolean;
  /** Resolves false when the save failed, so the picker stays open to retry. */
  onAdd: (foodId: string, opts: { phrase?: string; grams?: number }) => Promise<boolean>;
}

export function AddItemEditor({ busy, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const grams = Number(draft.replace(',', '.'));
  const hasAmount = draft.trim().length > 0;
  const validAmount = Number.isFinite(grams) && grams > 0 && grams <= MAX_GRAMS;

  const close = (): void => { setOpen(false); setDraft(''); };

  if (!open) {
    return (
      <Button
        label="Something missing? Add it"
        variant="secondary"
        disabled={busy}
        onPress={() => { setOpen(true); }}
        style={s.openButton}
      />
    );
  }

  return (
    <View style={s.wrap}>
      <View style={s.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={[type.smallStrong, { color: color.ink }]}>What else was there?</Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: 2 }]}>
            Search for it and pick a row. The rest of the meal is left alone.
          </Text>
        </View>
        <Pressable
          onPress={close}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel adding an item"
          hitSlop={8}
        >
          <Text style={[type.smallStrong, { color: color.inkFaint }]}>Cancel</Text>
        </Pressable>
      </View>

      {/*
        The amount comes first because it is set before the pick, not after: one
        tap on a result adds the item, and there is no second step to fill this
        in on. Optional on purpose — leaving it blank runs the same portion
        ladder every other item goes through, which is a wide honest estimate
        rather than a refusal.
      */}
      <View style={s.amountRow}>
        <Text style={[type.small, { color: color.inkMuted, flex: 1 }]}>
          Amount, if you know it
        </Text>
        <View style={[s.field, hasAmount && !validAmount && s.fieldBad]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            keyboardType="numeric"
            inputMode="decimal"
            selectTextOnFocus
            editable={!busy}
            placeholder="—"
            placeholderTextColor={color.inkFaint}
            accessibilityLabel="Amount in grams, optional"
            style={[
              type.monoStrong, numeric, s.input,
              { color: hasAmount && !validAmount ? color.danger : color.ink },
            ]}
          />
          <Text style={[type.label, { color: color.inkFaint }]}>g</Text>
        </View>
      </View>

      {/*
        Search is held closed while the amount field is unreadable. Adding the
        food anyway and quietly estimating would be the worst of the three
        available behaviours: the person typed a number, and dropping it
        without saying so lands them on a figure they think they set.
      */}
      {/*
        No `autoFocus`. This card opens at the very bottom of a long scroller,
        and focusing on mount raised the keyboard over a field that had not
        been scrolled to yet — a keyboard and nothing to type into. Let the
        person tap the field; by then it is on screen and stays there.
      */}
      <FoodPicker
        placeholder="e.g. ayran, 1 bardak"
        busy={busy || (hasAmount && !validAmount)}
        onPick={async (food, query) => {
          const saved = await onAdd(food.foodId, {
            // Their words, not the row's name. It is what teaches mise this
            // wording, and what tells the gap ledger what the extractor missed.
            ...(query.length > 0 ? { phrase: query } : {}),
            ...(validAmount ? { grams: Number(grams.toFixed(1)) } : {}),
          });
          if (saved) close();
          return saved;
        }}
      />

      <Text
        style={[
          type.label,
          {
            color: hasAmount && !validAmount ? color.danger : color.inkFaint,
            marginTop: space.md,
            lineHeight: 17,
          },
        ]}
      >
        {hasAmount && !validAmount
          ? `Enter a mass between 1 and ${MAX_GRAMS} g, or clear the field to let mise estimate.`
          : hasAmount
            ? 'Added at the amount you set, and mise remembers it for this wording.'
            : 'Without an amount mise estimates one, and shows how wide that estimate is.'}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  openButton: { marginTop: space.lg, minHeight: 46 },
  wrap: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md },
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
  // the baseline of the label beside it.
  input: { flex: 1, padding: 0, textAlign: 'center', minWidth: 46 },
});
