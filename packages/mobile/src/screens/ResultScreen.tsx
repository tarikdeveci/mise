import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type MealLog } from '../api';
import { MealItem } from '../components/MealItem';
import { BandChip, Button, Gauge } from '../components/ui';
import { color, numeric, radius, space, type } from '../theme';

const STATUS_COPY: Record<MealLog['status'], { title: string; detail: string }> = {
  confirmed: { title: 'Logged', detail: 'Everything matched clearly. Nothing to check.' },
  needs_review: { title: 'Worth a look', detail: 'One or two items are worth a glance.' },
  needs_input: { title: 'Needs you', detail: 'Answering moves the total more than anything else here.' },
};

const BAND_FOR: Record<MealLog['status'], 'high' | 'medium' | 'low'> = {
  confirmed: 'high', needs_review: 'medium', needs_input: 'low',
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
      // Re-log so the correction takes effect end to end. The fix is not a
      // local edit; it changes how that phrase resolves from now on.
      const refreshed = await api.logMeal({
        text: log.items.map((i) => i.extracted.phrase).join(', '),
      });
      onUpdate(refreshed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that correction.');
    } finally {
      setCorrecting(false);
    }
  };

  const question = log.questions.find((q) => !answered.has(q.itemId));

  return (
    <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Back to logging"
        hitSlop={12}
        style={({ pressed }) => [s.back, pressed && { opacity: 0.55 }]}
      >
        <Text style={[type.smallStrong, { color: color.primary }]}>‹  Log another</Text>
      </Pressable>

      {/* The readout. One committed surface: a number to act on, and the room
          it actually has. Everything below defers to this. */}
      <View style={s.readout}>
        <View style={s.readoutTop}>
          <Text style={[type.readout, numeric, { color: color.readoutInk }]}>
            {Math.round(likely.kcal)}
          </Text>
          <Text style={[type.title, { color: color.readoutMuted, marginBottom: 9 }]}>kcal</Text>
        </View>

        <View style={s.gauge}>
          <Gauge min={min.kcal} likely={likely.kcal} max={max.kcal} />
        </View>

        <Text style={[type.small, { color: color.readoutMuted, marginTop: space.md }]}>
          {spread > 0
            ? `Could be anywhere across ${spread} kcal. The width is the honest part.`
            : 'Everything here was stated exactly, so there is no range to show.'}
        </Text>

        <View style={s.macros}>
          <Macro label="Protein" value={likely.proteinG} />
          <Macro label="Carbs" value={likely.carbG} />
          <Macro label="Fat" value={likely.fatG} />
          <Macro label="Fibre" value={likely.fiberG} />
        </View>
      </View>

      <View style={s.status}>
        <BandChip band={BAND_FOR[log.status]} label={status.title} />
        <Text style={[type.small, { color: color.inkMuted, flex: 1 }]}>{status.detail}</Text>
      </View>

      {/* One question, not a form. Ranked by how many calories the answer moves. */}
      {question && (
        <View style={s.question}>
          <Text style={[type.bodyStrong, { color: color.ink }]}>{question.question}</Text>
          {question.expectedKcalSwing > 1 && (
            <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
              Worth asking: the answer moves this meal by up to{' '}
              {Math.round(question.expectedKcalSwing)} kcal.
            </Text>
          )}
        </View>
      )}

      {error && (
        <View style={s.error} accessibilityLiveRegion="polite">
          <Text style={[type.small, { color: color.ink }]}>{error}</Text>
        </View>
      )}

      {log.items.length === 0 ? (
        <View style={s.empty}>
          <Text style={[type.heading, { color: color.ink }]}>Nothing logged</Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: space.sm }]}>
            mise did not find food in that. It leaves the log empty rather than
            inventing a meal to look useful.
          </Text>
        </View>
      ) : (
        <View style={s.items}>
          <Text style={[type.small, { color: color.inkFaint, marginBottom: space.xs }]}>
            {log.items.length} {log.items.length === 1 ? 'item' : 'items'} · tap any of them to
            see where the number came from
          </Text>
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

      <Button label="Log another meal" variant="secondary" onPress={onClose} style={{ marginTop: space.xl }} />

      <Text style={[type.label, { color: color.inkFaint, marginTop: space.xl, lineHeight: 18 }]}>
        {log.provenance.extractorId} · {log.provenance.model} · pipeline{' '}
        {log.provenance.pipelineVersion} · {log.provenance.latencyMs} ms{'\n'}
        trace {log.provenance.traceId}
      </Text>
    </ScrollView>
  );
}

function Macro({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.macro}>
      <Text style={[type.bodyStrong, numeric, { color: color.readoutInk }]}>
        {value.toFixed(1)}
        <Text style={[type.label, { color: color.readoutMuted }]}>g</Text>
      </Text>
      <Text style={[type.label, { color: color.readoutMuted }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  content: { padding: space.xl, paddingTop: space.md, paddingBottom: space.xxxl },
  back: { paddingVertical: space.sm, marginBottom: space.md, alignSelf: 'flex-start' },

  readout: {
    backgroundColor: color.readout,
    borderRadius: radius.lg,
    padding: space.xl,
    paddingBottom: space.lg,
  },
  readoutTop: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  gauge: { marginTop: space.lg },
  macros: {
    flexDirection: 'row',
    marginTop: space.xl,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopColor: color.readoutEdge,
  },
  macro: { flex: 1, gap: 3 },

  status: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xl },
  question: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.primarySoft,
  },
  error: { marginTop: space.lg, padding: space.md, borderRadius: radius.md, backgroundColor: color.surface },
  items: { marginTop: space.xl },
  empty: { marginTop: space.lg, padding: space.lg, borderRadius: radius.md, backgroundColor: color.surface },
});
