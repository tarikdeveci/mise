import { useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LoggedItem } from '../api';
import { color, radius, space, type } from '../theme';
import { BandChip, ChoiceChip, RangeBar, useReducedMotion } from './ui';

// No `setLayoutAnimationEnabledExperimental` opt-in here: that was the
// old-architecture Android switch, and calling it under the New Architecture
// only produces a deprecation warning over the UI.

/** Human wording for how the match was made. Shown, not hidden in a log. */
const METHOD_COPY: Record<string, string> = {
  user_alias: 'You corrected this before',
  global_alias: 'Default for an ambiguous word',
  lexical: 'Matched by name',
  vector: 'Matched by meaning',
  llm_rerank: 'Model chose between close matches',
  composite: 'Broken into ingredients',
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
 * know", which is the question no competitor lets you ask: the matched
 * database row, the exact arithmetic, the portion assumption, and the other
 * candidates that were considered — each one a single tap away from being the
 * answer instead.
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
        style={({ pressed }) => [s.head, pressed && { backgroundColor: color.surface }]}
      >
        <View style={s.headText}>
          <Text style={[type.bodyStrong, { color: color.ink }]} numberOfLines={2}>
            {item.foodName ?? item.extracted.phrase}
          </Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: 2 }]} numberOfLines={1}>
            {unresolved
              ? `“${item.extracted.phrase}” — pick one below`
              : (item.portion?.assumption ?? '')}
          </Text>
        </View>

        <View style={s.headRight}>
          {unresolved ? (
            <Text style={[type.bodyStrong, { color: color.inkFaint }]}>—</Text>
          ) : (
            <>
              <Text style={[type.bodyStrong, { color: color.ink }]}>{Math.round(kcal)}</Text>
              <Text style={[type.label, { color: color.inkFaint }]}>kcal</Text>
            </>
          )}
        </View>
      </Pressable>

      <View style={s.meta}>
        <BandChip band={unresolved ? 'low' : item.confidence.band} />
        {!unresolved && item.nutrition && (
          <View style={s.miniRange}>
            <RangeBar
              compact
              min={item.nutrition.min.kcal}
              max={item.nutrition.max.kcal}
              likely={item.nutrition.likely.kcal}
            />
          </View>
        )}
      </View>

      {(open || unresolved) && (
        <View style={s.detail}>
          {!unresolved && (
            <>
              <Text style={[type.label, { color: color.inkMuted }]}>HOW THIS NUMBER WAS MADE</Text>
              <Text style={[type.small, { color: color.ink, marginTop: space.xs }]}>
                {METHOD_COPY[item.resolution.method] ?? item.resolution.method}
              </Text>
              {item.portion && item.nutrition && (
                <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
                  {item.portion.gramsLikely} g, {Math.round(item.nutrition.min.kcal)}–
                  {Math.round(item.nutrition.max.kcal)} kcal
                </Text>
              )}
              {item.source && (
                <Text style={[type.small, { color: color.inkFaint, marginTop: space.xs }]}>
                  Source: {item.source}
                </Text>
              )}
            </>
          )}

          {alternatives.length > 0 && (
            <>
              <Text style={[type.label, { color: color.inkMuted, marginTop: space.lg }]}>
                {unresolved ? 'DID YOU MEAN' : 'OR DID YOU MEAN'}
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
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingVertical: space.md,
  },
  wrapUnresolved: { backgroundColor: color.askSoft, paddingHorizontal: space.md, borderRadius: radius.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, borderRadius: radius.sm },
  headText: { flex: 1 },
  headRight: { alignItems: 'flex-end', minWidth: 52 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm },
  miniRange: { flex: 1 },
  detail: { marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.border },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
});
