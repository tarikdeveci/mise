import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type MealLog } from '../api';
import { MealItem } from '../components/MealItem';
import { BandChip, Button, RangeBar } from '../components/ui';
import { color, radius, space, type } from '../theme';

const STATUS_COPY: Record<MealLog['status'], { title: string; detail: string }> = {
  confirmed: { title: 'Logged', detail: 'Everything matched clearly. Nothing to check.' },
  needs_review: { title: 'Logged, with a caveat', detail: 'One or two items are worth a glance.' },
  needs_input: { title: 'One question first', detail: 'Answering moves the total more than anything else here.' },
};

interface Props {
  log: MealLog;
  onClose: () => void;
  onUpdate: (log: MealLog) => void;
}

export function ResultScreen({ log, onClose, onUpdate }: Props) {
  const [correcting, setCorrecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());

  const { likely, min, max } = log.totals;
  const status = STATUS_COPY[log.status];
  const spread = Math.round(max.kcal - min.kcal);

  const correct = async (itemId: string, foodId: string) => {
    setCorrecting(true);
    setError(null);
    try {
      await api.correct(log.id, itemId, foodId);
      setAnswered((prev) => new Set(prev).add(itemId));
      // Re-log the same text so the correction takes effect end to end. This is
      // the loop the user should be able to feel: the fix is not a local edit,
      // it changes how the phrase resolves from now on.
      const phrase = log.items.find((i) => i.id === itemId)?.extracted.phrase;
      if (phrase) {
        const refreshed = await api.logMeal({
          text: log.items.map((i) => i.extracted.phrase).join(', '),
        });
        onUpdate(refreshed);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that correction.');
    } finally {
      setCorrecting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.content}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Back to logging"
        style={({ pressed }) => [s.back, pressed && { opacity: 0.6 }]}
      >
        <Text style={[type.smallStrong, { color: color.primary }]}>‹  Log another</Text>
      </Pressable>

      {/* The headline. A number to act on, and the room it actually has. */}
      <View style={s.headline}>
        <View style={s.headlineTop}>
          <Text style={[type.display, { color: color.ink }]}>{Math.round(likely.kcal)}</Text>
          <Text style={[type.heading, { color: color.inkMuted, marginBottom: 5 }]}>kcal</Text>
        </View>

        <View style={s.band}>
          <RangeBar min={min.kcal} likely={likely.kcal} max={max.kcal} />
        </View>

        <Text style={[type.small, { color: color.inkMuted, marginTop: space.sm }]}>
          {spread > 0
            ? `Could be anywhere in a ${spread} kcal range. The width is the honest part.`
            : 'Everything here was stated exactly, so there is no range to show.'}
        </Text>
      </View>

      <View style={s.macros}>
        <Macro label="Protein" value={likely.proteinG} />
        <Macro label="Carbs" value={likely.carbG} />
        <Macro label="Fat" value={likely.fatG} />
        <Macro label="Fibre" value={likely.fiberG} />
      </View>

      <View style={s.status}>
        <BandChip
          band={log.status === 'confirmed' ? 'high' : log.status === 'needs_review' ? 'medium' : 'low'}
          label={status.title}
        />
        <Text style={[type.small, { color: color.inkMuted, flex: 1 }]}>{status.detail}</Text>
      </View>

      {/* One question, not a form. Ranked by how many calories the answer moves. */}
      {log.questions
        .filter((q) => !answered.has(q.itemId))
        .slice(0, 1)
        .map((q) => (
          <View key={q.itemId} style={s.question}>
            <Text style={[type.bodyStrong, { color: color.ink }]}>{q.question}</Text>
            {q.expectedKcalSwing > 1 && (
              <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
                Worth asking: the answer moves this meal by up to {Math.round(q.expectedKcalSwing)} kcal.
              </Text>
            )}
          </View>
        ))}

      {error && (
        <View style={s.error} accessibilityLiveRegion="polite">
          <Text style={[type.small, { color: color.ink }]}>{error}</Text>
        </View>
      )}

      <Text style={[type.label, { color: color.inkMuted, marginTop: space.xl }]}>
        {log.items.length} {log.items.length === 1 ? 'ITEM' : 'ITEMS'}
      </Text>

      {log.items.length === 0 ? (
        <View style={s.empty}>
          <Text style={[type.bodyStrong, { color: color.ink }]}>Nothing logged</Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
            mise did not find food in that. It leaves the log empty rather than
            inventing a meal to look useful.
          </Text>
        </View>
      ) : (
        <View style={s.items}>
          {log.items.map((item) => (
            <MealItem
              key={item.id}
              item={item}
              correcting={correcting}
              onCorrect={(itemId, foodId) => { void correct(itemId, foodId); }}
            />
          ))}
        </View>
      )}

      <View style={s.provenance}>
        <Text style={[type.label, { color: color.inkMuted }]}>HOW THIS WAS PRODUCED</Text>
        <Text style={[type.small, { color: color.inkFaint, marginTop: space.xs }]}>
          {log.provenance.extractorId} · {log.provenance.model}
        </Text>
        <Text style={[type.small, { color: color.inkFaint }]}>
          pipeline {log.provenance.pipelineVersion} · prompt {log.provenance.promptVersion} ·{' '}
          {log.provenance.latencyMs} ms
        </Text>
        <Text style={[type.small, { color: color.inkFaint }]}>trace {log.provenance.traceId}</Text>
      </View>

      <Button label="Log another meal" variant="secondary" onPress={onClose} style={{ marginTop: space.xl }} />
    </ScrollView>
  );
}

function Macro({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.macro}>
      <Text style={[type.bodyStrong, { color: color.ink }]}>{value.toFixed(1)}<Text style={type.label}>g</Text></Text>
      <Text style={[type.label, { color: color.inkMuted }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  content: { padding: space.xl, paddingBottom: space.xxxl },
  back: { paddingVertical: space.sm, marginBottom: space.md },
  headline: { marginTop: space.sm },
  headlineTop: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  band: { marginTop: space.md },
  macros: {
    flexDirection: 'row',
    marginTop: space.xl,
    paddingVertical: space.lg,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.border,
  },
  macro: { flex: 1, gap: 2 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg },
  question: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.askSoft,
  },
  error: { marginTop: space.lg, padding: space.md, borderRadius: radius.md, backgroundColor: color.reviewSoft },
  items: { marginTop: space.sm },
  empty: {
    marginTop: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  provenance: {
    marginTop: space.xxl,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopColor: color.border,
  },
});
