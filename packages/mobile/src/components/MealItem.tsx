import { useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LoggedItem } from '../api';
import { color, numeric, radius, space, type } from '../theme';
import { BandChip, ChoiceChip, MiniRange, useReducedMotion } from './ui';

// No `setLayoutAnimationEnabledExperimental` opt-in here: that was the
// old-architecture Android switch, and calling it under the New Architecture
// only produces a deprecation warning over the UI.

/** Human wording for how the match was made. Shown, not buried in a log. */
const METHOD_COPY: Record<string, string> = {
  user_alias: 'You corrected this before, so it was matched instantly',
  global_alias: 'A curated default for an ambiguous word',
  lexical: 'Matched by name',
  vector: 'Matched by meaning across languages',
  llm_rerank: 'Two foods looked equally likely, so a model chose between them',
  composite: 'Broken into its ingredients',
  unresolved: 'Not matched yet',
};

interface Props {
  item: LoggedItem;
  onCorrect: (itemId: string, foodId: string) => void;
  correcting?: boolean;
}

/**
 * One logged food.
 *
 * Collapsed it answers "what and how much". Expanded it answers "how do you
 * know" — the matched database row, the exact arithmetic, the portion
 * assumption, and the other candidates that were considered, each one tap away
 * from becoming the answer instead.
 */
export function MealItem({ item, onCorrect, correcting }: Props) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  const kcal = item.nutrition?.likely.kcal ?? 0;
  const unresolved = item.foodId === null;

  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((v) => !v);
  };

  const alternatives = item.resolution.candidates
    .filter((c) => c.foodId !== item.foodId)
    .slice(0, 3);

  return (
    <View style={[s.wrap, unresolved && s.wrapUnresolved]}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${item.foodName ?? item.extracted.phrase}, ${Math.round(kcal)} calories. Tap for details.`}
        hitSlop={6}
      >
        <View style={s.head}>
          <Text style={[type.bodyStrong, { color: color.ink, flex: 1 }]} numberOfLines={2}>
            {item.foodName ?? item.extracted.phrase}
          </Text>
          {unresolved ? (
            <Text style={[type.bodyStrong, { color: color.inkFaint }]}>—</Text>
          ) : (
            <Text style={[type.monoStrong, numeric, { color: color.ink }]}>
              {Math.round(kcal)}
              <Text style={[type.label, { color: color.inkFaint }]}> kcal</Text>
            </Text>
          )}
        </View>

        <Text style={[type.small, { color: color.inkMuted, marginTop: 1 }]} numberOfLines={1}>
          {unresolved
            ? `“${item.extracted.phrase}” — pick one below`
            : (item.portion?.assumption ?? '')}
        </Text>

        <View style={s.meta}>
          <BandChip band={unresolved ? 'low' : item.confidence.band} />
          {!unresolved && item.nutrition && (
            <View style={s.miniRange}>
              <MiniRange
                min={item.nutrition.min.kcal}
                max={item.nutrition.max.kcal}
                likely={item.nutrition.likely.kcal}
              />
            </View>
          )}
        </View>
      </Pressable>

      {(open || unresolved) && (
        <View style={s.detail}>
          {!unresolved && (
            <>
              <Text style={[type.small, { color: color.ink }]}>
                {METHOD_COPY[item.resolution.method] ?? item.resolution.method}
              </Text>
              {item.portion && item.nutrition && (
                <Text style={[type.mono, numeric, { color: color.inkMuted, marginTop: space.xs }]}>
                  {item.portion.gramsLikely} g → {Math.round(item.nutrition.min.kcal)}–
                  {Math.round(item.nutrition.max.kcal)} kcal
                </Text>
              )}
              {item.source && (
                <Text style={[type.label, { color: color.inkFaint, marginTop: space.sm }]}>
                  {item.source}
                </Text>
              )}
            </>
          )}

          {alternatives.length > 0 && (
            <>
              <Text style={[type.smallStrong, { color: color.ink, marginTop: space.lg }]}>
                {unresolved ? 'Did you mean' : 'Or did you mean'}
              </Text>
              <View style={s.choices}>
                {alternatives.map((c) => (
                  <ChoiceChip
                    key={c.foodId}
                    label={c.name}
                    disabled={correcting}
                    onPress={() => { onCorrect(item.id, c.foodId); }}
                  />
                ))}
              </View>
              <Text style={[type.small, { color: color.inkFaint, marginTop: space.sm }]}>
                Correcting this teaches mise your wording. Next time it matches instantly.
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingVertical: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  wrapUnresolved: {
    backgroundColor: color.primarySoft,
    paddingHorizontal: space.lg,
    marginHorizontal: -space.lg,
    borderRadius: radius.md,
    borderBottomWidth: 0,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md },
  miniRange: { flex: 1 },
  detail: { marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.border },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
});
