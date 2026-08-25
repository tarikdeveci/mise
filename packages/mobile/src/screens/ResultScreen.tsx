import { useState } from 'react';
import {
  KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { api, ApiError, type MealLog, type Question } from '../api';
import { AddItemEditor } from '../components/AddItemEditor';
import { MealItem } from '../components/MealItem';
import { QuestionCard } from '../components/QuestionCard';
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

/**
 * A question is identified by what it asks about, not by which item it is on.
 *
 * Answering one changes the item, which can raise a different question about
 * the same line — "which cheese" settled, "how much of it" still open. Keying
 * on the item alone would hide that second question forever; keying on the text
 * as well lets each one be asked exactly once.
 */
const keyOf = (q: Question): string => `${q.itemId}::${q.question}`;

interface Props {
  log: MealLog;
  onClose: () => void;
  onUpdate: (log: MealLog) => void;
}

export function ResultScreen({ log, onClose, onUpdate }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Questions the user has answered or skipped, by `keyOf`. */
  const [settled, setSettled] = useState<Set<string>>(new Set());

  const { likely, min, max } = log.totals;
  const status = STATUS_COPY[log.status];
  const spread = Math.round(max.kcal - min.kcal);

  /**
   * Sends a correction and renders the meal the server sends back.
   *
   * The screen used to re-log the meal from its own item phrases to see a
   * correction take effect. That could not move an amount the user had stated
   * in words, replaced photographs with text, and gave every item a new id —
   * which is what made the question flow restart from the top after each
   * answer. The server now applies the correction to this meal and returns it.
   */
  const submit = async (
    itemId: string,
    change: { foodId?: string; grams?: number },
    onSaved?: () => void,
  ): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const { log: updated } = await api.correct(log.id, itemId, change.foodId, change.grams);
      onSaved?.();
      onUpdate(updated);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that. Try again.');
      return false;
    } finally { setBusy(false); }
  };

  /**
   * Adds a food that was never on the list.
   *
   * Every other control here edits a line that exists, so a plate read as four
   * items when there were five had no repair at all — nothing on the screen
   * was wrong, one thing was simply absent. The server appends the line and
   * returns this meal recomputed, so the photograph, the item ids and every
   * correction already made to it survive.
   */
  const add = async (
    foodId: string,
    opts: { phrase?: string; grams?: number },
  ): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const { log: updated } = await api.addItem(log.id, foodId, opts);
      onUpdate(updated);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that. Try again.');
      return false;
    } finally { setBusy(false); }
  };

  // A notice with only a dismiss option is not a question. Unresolved items
  // now have their correction search on the item itself, so showing a large
  // “Got it” card above the actual control adds a dead step and repeats the
  // same message twice.
  const pending = log.questions.filter((q) =>
    q.options.some((option) => option.foodId !== null || option.grams !== null)
    && !settled.has(keyOf(q)));
  const question = pending[0];
  const settle = (q: Question): void => {
    setSettled((prev) => new Set(prev).add(keyOf(q)));
  };

  const answer = (option: Question['options'][number]): void => {
    if (!question) return;
    if (option.foodId === null && option.grams === null) { settle(question); return; }
    void submit(
      question.itemId,
      {
        ...(option.foodId !== null ? { foodId: option.foodId } : {}),
        ...(option.grams !== null ? { grams: option.grams } : {}),
      },
      () => { settle(question); },
    );
  };

  /**
   * Nothing on the plate could be named, so the zero is an absence rather than
   * a measurement. Without this the readout said "everything here was stated
   * exactly, so there is no range to show" over an empty log — the spread is
   * zero for both, and claiming exactness about a meal we failed to read is
   * the one thing this screen must never do.
   */
  const nothingLogged = log.items.length > 0 && log.items.every((i) => i.foodId === null);

  /**
   * Only worth offering when the photo actually had no scale reference. Asking
   * again after the user already put a card in frame would be nagging, and the
   * gain has already been taken.
   */
  const photoWithoutReference = log.items.some(
    (i) => i.portion?.fromVision && i.portion.method !== 'reference_scaled',
  );

  return (
    /*
      Every editable field on this screen — the amount, the correction search,
      the add-an-item search — sits at the bottom of a long scroller, and under
      Android's edge-to-edge windowing the keyboard is drawn *over* the app
      rather than resizing it. Without this the scroller's own bottom is behind
      the keyboard, so a field down there cannot be scrolled to at all: you get
      a keyboard and no way to see what you are typing into. `padding` on both
      platforms because neither one resizes the window for us here.
    */
    <KeyboardAvoidingView style={s.flex} behavior="padding">
      <ScrollView
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        // The amount field is inside this scroller. Without this, the first tap
        // on Save only dismisses the keyboard and the user has to tap twice.
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Back to logging"
          hitSlop={12}
          style={({ pressed }) => [s.back, pressed && { opacity: 0.55 }]}
        >
          <Text style={[type.smallStrong, { color: color.signal }]}>‹  Log another</Text>
        </Pressable>

        {/* The readout. A number to act on, and the room it actually has. */}
        <View style={s.readout}>
          <View style={s.readoutTop}>
            <Text style={[type.readout, numeric, { color: color.ink }]}>
              {Math.round(likely.kcal)}
            </Text>
            <Text style={[type.title, { color: color.inkMuted, marginBottom: 9 }]}>kcal</Text>
          </View>

          <View style={s.gauge}>
            <Gauge min={min.kcal} likely={likely.kcal} max={max.kcal} />
          </View>

          <Text style={[type.small, { color: color.inkMuted, marginTop: space.md }]}>
            {nothingLogged
              ? 'Nothing here could be matched to a food, so this is not a zero — it is a blank. Pick a food below, or describe it another way.'
              : spread > 0
                ? `Could be anywhere across ${spread} kcal. The width is the honest part — set an amount below to close it.`
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

        {/*
          The reference-object offer, made here rather than before the shot. The
          user has just seen how wide the range is, so the trade is legible: one
          card in frame roughly halves it. Asking before they had a reason would
          have been a chore.
        */}
        {photoWithoutReference && (
          <View style={s.offer}>
            <Text style={[type.bodyStrong, { color: color.ink }]}>
              This range is wide because nothing gave it a scale.
            </Text>
            <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
              Put a bank card next to the plate and shoot again. Published work puts
              that at roughly half the calorie error, and it costs you one second.
            </Text>
          </View>
        )}

        {question && (
          <QuestionCard
            question={question}
            position={settled.size + 1}
            total={settled.size + pending.length}
            currentFoodId={log.items.find((i) => i.id === question.itemId)?.foodId ?? null}
            busy={busy}
            onAnswer={answer}
            onSkip={() => { settle(question); }}
          />
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
              inventing a meal to look useful — but you can name the foods yourself.
            </Text>
          </View>
        ) : (
          <View style={s.items}>
            <Text style={[type.small, { color: color.inkFaint, marginBottom: space.xs }]}>
              {log.items.length} {log.items.length === 1 ? 'item' : 'items'} · tap any of them to
              see where the number came from, or to change the amount
            </Text>
            {log.items.map((item) => (
              <MealItem
                key={item.id}
                item={item}
                busy={busy}
                onCorrectFood={(id, foodId) => submit(id, { foodId })}
                onCorrectPortion={(id, grams) => { void submit(id, { grams }); }}
              />
            ))}
          </View>
        )}

        {/*
          Under the list, and offered on an empty log too — a meal mise could not
          read at all is the case where adding by hand matters most, and it was
          the one place the screen previously offered nothing to do.
        */}
        <AddItemEditor busy={busy} onAdd={add} />

        <Button label="Log another meal" variant="secondary" onPress={onClose} style={{ marginTop: space.xl }} />

        <Text style={[type.label, { color: color.inkFaint, marginTop: space.xl, lineHeight: 18 }]}>
          {log.provenance.extractorId} · {log.provenance.model} · pipeline{' '}
          {log.provenance.pipelineVersion} · {log.provenance.latencyMs} ms{'\n'}
          trace {log.provenance.traceId}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Macro({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.macro}>
      <Text style={[type.monoStrong, numeric, { color: color.ink }]}>
        {value.toFixed(1)}
        <Text style={[type.label, { color: color.inkFaint }]}>g</Text>
      </Text>
      <Text style={[type.label, { color: color.inkFaint }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.xl, paddingTop: space.lg, paddingBottom: space.xxxl },
  back: { paddingVertical: space.sm, marginBottom: space.md, alignSelf: 'flex-start' },

  readout: {
    backgroundColor: color.raised,
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
    borderTopColor: color.line,
  },
  macro: { flex: 1, gap: 3 },

  status: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xl },
  offer: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.signalDim,
  },
  error: {
    marginTop: space.lg, padding: space.md, borderRadius: radius.md,
    backgroundColor: color.raised,
  },
  items: { marginTop: space.xl },
  empty: {
    marginTop: space.lg, padding: space.lg, borderRadius: radius.md,
    backgroundColor: color.surface,
  },
});
