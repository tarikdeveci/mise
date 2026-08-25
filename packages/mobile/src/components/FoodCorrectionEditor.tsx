import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LoggedItem } from '../api';
import { color, radius, space, type } from '../theme';
import { FoodPicker } from './FoodPicker';
import { Button } from './ui';

interface Props {
  item: LoggedItem;
  busy?: boolean;
  onSelect: (itemId: string, foodId: string) => Promise<boolean>;
}

/**
 * Corrects the identity of exactly one extracted meal item.
 *
 * Free text is only a search query. Nutrition still comes from the verified
 * row the person chooses, and the correction endpoint records the mapping from
 * the model's original phrase to that row for this user. That makes the meal
 * right now and the same mistake deterministic next time.
 *
 * The search itself lives in `FoodPicker`, because adding a food mise missed
 * needs the identical control and the two must not drift apart.
 */
export function FoodCorrectionEditor({ item, busy, onSelect }: Props) {
  const unresolved = item.foodId === null;
  const [editing, setEditing] = useState(unresolved);

  useEffect(() => {
    if (!unresolved) return;
    setEditing(true);
  }, [unresolved]);

  if (!editing) {
    return (
      <Button
        label="Wrong food? Change it"
        variant="ghost"
        disabled={busy}
        onPress={() => { setEditing(true); }}
        style={s.openButton}
      />
    );
  }

  return (
    <View style={s.wrap}>
      <View style={s.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={[type.smallStrong, { color: color.ink }]}>
            {unresolved ? 'What was this?' : 'What was it instead?'}
          </Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: 2 }]}>
            Correct “{item.extracted.phrase}” without changing the other items.
          </Text>
        </View>
        {!unresolved && (
          <Pressable
            onPress={() => { setEditing(false); }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Cancel food correction"
            hitSlop={8}
          >
            <Text style={[type.smallStrong, { color: color.inkFaint }]}>Cancel</Text>
          </Pressable>
        )}
      </View>

      <FoodPicker
        placeholder="e.g. sweet potato"
        busy={busy}
        onPick={async (food) => {
          const saved = await onSelect(item.id, food.foodId);
          if (saved) setEditing(false);
          return saved;
        }}
      />

      <Text style={[type.label, { color: color.inkFaint, marginTop: space.md, lineHeight: 17 }]}>
        Choosing a verified row fixes only this line and teaches mise this wording for next time.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  openButton: { marginTop: space.md, minHeight: 44, alignSelf: 'stretch' },
});
