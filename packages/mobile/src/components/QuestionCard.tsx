import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Question } from '../api';
import { color, numeric, radius, space, type } from '../theme';

/**
 * One clarification question, asked on its own.
 *
 * The previous version printed the question text and nothing else. The options
 * the server had already worked out — the foods it was choosing between, the
 * amounts in grams — were on the wire and never rendered, so the only way to
 * answer was to scroll into the item list, guess which line the question was
 * about, expand it and find a chip. That is the "confusing" part: the question
 * and its answers were in two different places, and one of them was hidden.
 *
 * So: one question at a time, its own answers directly underneath it, its
 * position in the queue on the top line, and a way past it that does not
 * require answering. A survey, in the order a survey is asked.
 */

interface Props {
  question: Question;
  /** 1-based, for "Question 2 of 3". */
  position: number;
  total: number;
  /**
   * What the item currently resolves to, so the option that is already the
   * answer can say so. Without it, "is this right?" and "did you mean one of
   * these instead?" look like the same four identical rows.
   */
  currentFoodId?: string | null;
  busy?: boolean;
  onAnswer: (option: Question['options'][number]) => void;
  onSkip: () => void;
}

export function QuestionCard({
  question, position, total, currentFoodId, busy, onAnswer, onSkip,
}: Props) {
  const answerable = question.options.length > 0;

  return (
    <View style={s.wrap} accessibilityLiveRegion="polite">
      <View style={s.head}>
        <Text style={[type.label, numeric, { color: color.signal, letterSpacing: 0.8 }]}>
          {total > 1 ? `QUESTION ${position} OF ${total}` : 'ONE QUESTION'}
        </Text>
        {question.expectedKcalSwing > 1 && (
          <Text style={[type.label, numeric, { color: color.inkFaint }]}>
            ±{Math.round(question.expectedKcalSwing)} kcal
          </Text>
        )}
      </View>

      <Text style={[type.heading, { color: color.ink, marginTop: space.sm }]}>
        {question.question}
      </Text>

      {/* Without options there is nothing to pick: the card is mise saying what
          it could not do, and inventing a subtitle for that would be padding. */}
      {answerable && (
        <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
          {question.expectedKcalSwing > 1
            ? `Of everything left, this answer moves the total most — by up to ${Math.round(question.expectedKcalSwing)} kcal.`
            : 'Answering settles this item for good.'}
        </Text>
      )}

      {answerable && (
        <View style={s.options}>
          {question.options.map((option, at) => (
            <Option
              key={`${option.foodId ?? 'g'}-${option.grams ?? at}`}
              label={option.label}
              current={option.grams === null && option.foodId === currentFoodId}
              disabled={busy}
              onPress={() => { onAnswer(option); }}
            />
          ))}
        </View>
      )}

      <Pressable
        onPress={onSkip}
        disabled={busy}
        accessibilityRole="button"
        hitSlop={8}
        style={({ pressed }) => [s.skip, pressed && { opacity: 0.55 }]}
      >
        <Text style={[type.smallStrong, { color: color.inkFaint }]}>
          {answerable ? 'Not sure — skip this' : 'Got it'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Full width rather than a pill: a food name can be "Cheese, kaşar (Turkish
 * yellow cheese)", and a chip that long wraps into an unreadable blob.
 */
function Option({
  label, onPress, current, disabled,
}: { label: string; onPress: () => void; current?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={current ? `${label}, currently chosen` : label}
      style={({ pressed }) => [
        s.option,
        { backgroundColor: pressed ? color.raised : 'transparent' },
        current && { borderColor: color.signal },
        disabled && { opacity: 0.4 },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: color.ink }]}>{label}</Text>
        {current && (
          <Text style={[type.label, { color: color.signal }]}>
            what mise picked · tap to confirm
          </Text>
        )}
      </View>
      <Text style={[type.smallStrong, { color: color.signal }]}>›</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.signalDim,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  options: { marginTop: space.lg, gap: space.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    minHeight: 50,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
  },
  skip: { alignSelf: 'flex-start', paddingVertical: space.md, marginTop: space.xs },
});
