import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type MealLog } from '../api';
import { BandChip, MiniRange, Skeleton } from '../components/ui';
import { color, numeric, radius, space, type } from '../theme';

const BAND_FOR: Record<MealLog['status'], 'high' | 'medium' | 'low'> = {
  confirmed: 'high', needs_review: 'medium', needs_input: 'low',
};

interface Props {
  onOpen: (log: MealLog) => void;
  onLogged: (log: MealLog) => void;
}

export function HistoryScreen({ onOpen, onLogged }: Props) {
  const [meals, setMeals] = useState<MealLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [repeating, setRepeating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.history();
      setMeals(res.meals);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach mise. Check that the API is running.');
      setMeals([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => { setRefreshing(false); });
  }, [load]);

  /**
   * Log the same meal again.
   *
   * Most logging is repetition, and a repeat needs no estimation at all: the
   * phrases resolve through the alias rungs, and any portion this person has
   * confirmed replays exactly. This is the cheapest accurate log the product
   * has, so it is one tap rather than buried in a menu.
   */
  const repeat = async (meal: MealLog) => {
    setRepeating(meal.id);
    setError(null);
    try {
      onLogged(await api.logMeal({
        text: meal.items.map((i) => i.extracted.phrase).join(', '),
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log that again.');
    } finally {
      setRepeating(null);
    }
  };

  // Skeletons rather than a spinner: the shape of what is coming is known.
  if (meals === null) {
    return (
      <ScrollView contentContainerStyle={s.content}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={s.skeletonRow}>
            <Skeleton height={19} width="55%" />
            <Skeleton height={13} width="35%" />
            <Skeleton height={8} />
          </View>
        ))}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />
      }
    >
      {error && (
        <View style={s.error} accessibilityLiveRegion="polite">
          <Text style={[type.small, { color: color.ink }]}>{error}</Text>
        </View>
      )}

      {meals.length === 0 && !error ? (
        <View style={s.empty}>
          <Text style={[type.title, { color: color.ink }]}>No meals yet</Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: space.sm }]}>
            Log one from the other tab. Everything you log keeps its full trace,
            so you can come back and see which database row and which portion
            assumption produced each number.
          </Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: space.md }]}>
            Meals you have logged before come back here as a single tap, and a
            portion you have confirmed is replayed rather than estimated.
          </Text>
        </View>
      ) : (
        meals.map((meal) => (
          <View key={meal.id} style={s.row}>
            <Pressable
              onPress={() => { onOpen(meal); }}
              accessibilityRole="button"
              accessibilityLabel={`${Math.round(meal.totals.likely.kcal)} calories, ${meal.items.length} items`}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <View style={s.rowTop}>
                <Text style={[type.bodyStrong, { color: color.ink, flex: 1 }]} numberOfLines={1}>
                  {meal.items.map((i) => i.foodName ?? i.extracted.phrase).join(', ') || 'Empty log'}
                </Text>
                <Text style={[type.monoStrong, numeric, { color: color.ink }]}>
                  {Math.round(meal.totals.likely.kcal)}
                </Text>
              </View>

              <View style={s.rowMeta}>
                <BandChip band={BAND_FOR[meal.status]} />
                <Text style={[type.label, { color: color.inkFaint }]}>
                  {new Date(meal.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>

              {meal.totals.max.kcal > meal.totals.min.kcal && (
                <View style={s.rowRange}>
                  <MiniRange
                    min={meal.totals.min.kcal}
                    likely={meal.totals.likely.kcal}
                    max={meal.totals.max.kcal}
                  />
                </View>
              )}
            </Pressable>

            {meal.items.length > 0 && (
              <Pressable
                onPress={() => { void repeat(meal); }}
                disabled={repeating !== null}
                accessibilityRole="button"
                accessibilityLabel="Log this meal again"
                style={({ pressed }) => [
                  s.repeat,
                  pressed && { backgroundColor: color.raised },
                  repeating !== null && { opacity: 0.5 },
                ]}
              >
                <Text style={[type.smallStrong, { color: color.signal }]}>
                  {repeating === meal.id ? 'Logging…' : 'Log this again'}
                </Text>
              </Pressable>
            )}
          </View>
        ))
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: space.xl, paddingBottom: space.xxxl, gap: space.md },
  skeletonRow: {
    gap: space.sm, paddingVertical: space.lg,
    borderBottomWidth: 1, borderBottomColor: color.line,
  },
  row: {
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    marginHorizontal: -space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    gap: space.sm,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm },
  rowRange: { marginTop: space.sm },
  repeat: {
    marginTop: space.sm,
    alignSelf: 'flex-start',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginLeft: -space.md,
    borderRadius: radius.sm,
  },
  empty: { paddingVertical: space.xxl },
  error: { padding: space.md, borderRadius: radius.md, backgroundColor: color.raised },
});
