import { useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LoggedItem } from '../api';
import { color, numeric, radius, space, type } from '../theme';
import { FoodCorrectionEditor } from './FoodCorrectionEditor';
import { PortionEditor } from './PortionEditor';
import { BandChip, ChoiceChip, MethodChip, MiniRange, useReducedMotion } from './ui';

/** Human wording for how the food was identified. Shown, not buried in a log. */
const RESOLUTION_COPY: Record<string, string> = {
  barcode: 'Read off the scanned label',
  user_alias: 'You corrected this — mise will match it instantly next time',
  global_alias: 'A curated default for an ambiguous word',
  lexical: 'Matched by name',
  vector: 'Matched by meaning across languages',
  llm_rerank: 'Two foods looked equally likely, so a model chose between them',
  composite: 'Broken into its ingredients',
  unresolved: 'Not matched yet',
};

/** Below this retrieval score a candidate is not a suggestion, whatever it looks like. */
const OFFERABLE_SCORE = 0.72;

interface Props {
  item: LoggedItem;
  onCorrectFood: (itemId: string, foodId: string) => Promise<boolean>;
  onCorrectPortion: (itemId: string, grams: number) => void;
  busy?: boolean;
}

/**
 * One logged food.
 *
 * Collapsed it answers "what and how much". Expanded it answers "how do you
 * know" — which rung of the ladder produced the amount, the matched database
 * row, the literal arithmetic, and the other candidates that were considered,
 * each one tap from becoming the answer instead.
 */
export function MealItem({ item, onCorrectFood, onCorrectPortion, busy }: Props) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  const kcal = item.nutrition?.likely.kcal ?? 0;
  const unresolved = item.foodId === null;

  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((v) => !v);
  };

  // Same bar the server uses to decide what is worth offering as a choice
  // (`OFFERABLE_SCORE` in `pipeline/questions.ts`, which is the router's own
  // `SELF_EVIDENT_SCORE`). This screen was not applying it, so the two
  // disagreed about the same item: the question card said mise does not know
  // "guacamole", and the card directly below it offered diet cola and milk
  // chocolate as things the user might have meant. Multilingual embeddings
  // have a high similarity floor — unrelated short strings sit around
  // 0.45-0.55 — so an unfiltered candidate list is noise, and tapping any of
  // it would store that food as this user's alias for the word.
  const alternatives = item.resolution.candidates
    .filter((c) => c.foodId !== item.foodId && c.score >= OFFERABLE_SCORE)
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
            // "pick one below" has to be true. With nothing above the offerable
            // bar there is nothing to pick, and promising a choice that is not
            // there reads as a broken screen rather than an honest one.
            ? (alternatives.length > 0
              ? `“${item.extracted.phrase}” — pick one below or search`
              : `“${item.extracted.phrase}” — not matched confidently yet`)
            : (item.portion?.assumption ?? '')}
        </Text>

        <View style={s.meta}>
          <BandChip band={unresolved ? 'low' : item.confidence.band} />
          {item.portion && (
            <MethodChip
              method={item.portion.method}
              min={item.portion.gramsMin}
              likely={item.portion.gramsLikely}
              max={item.portion.gramsMax}
            />
          )}
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
                {RESOLUTION_COPY[item.resolution.method] ?? item.resolution.method}
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
                    disabled={busy}
                    onPress={() => { void onCorrectFood(item.id, c.foodId); }}
                  />
                ))}
              </View>
            </>
          )}

          <FoodCorrectionEditor
            item={item}
            busy={busy}
            onSelect={onCorrectFood}
          />

          {/*
            Correcting the amount is what teaches the `user_memory` rung. Next
            time this phrase appears the portion is replayed rather than
            estimated, which is the only rung that improves with use.

            Offered on every resolved item, with no exception for the ones whose
            amount was stated in words. Hiding it there was the bug: a typed
            "150 g" pins the top rung of the ladder, so the old flow recorded
            the correction, re-logged, read the stated mass again and showed the
            same number back. The correction now applies to this meal directly.
          */}
          {!unresolved && (
            <PortionEditor
              item={item}
              busy={busy}
              onSet={(grams) => { onCorrectPortion(item.id, grams); }}
            />
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingVertical: space.lg, borderBottomWidth: 1, borderBottomColor: color.line },
  wrapUnresolved: {
    backgroundColor: color.surface,
    paddingHorizontal: space.lg,
    marginHorizontal: -space.lg,
    borderRadius: radius.md,
    borderBottomWidth: 0,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  meta: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
    gap: space.sm, marginTop: space.md,
  },
  miniRange: { flex: 1, minWidth: 60 },
  detail: { marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
});
