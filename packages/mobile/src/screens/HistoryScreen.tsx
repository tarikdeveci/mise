import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type MealLog } from '../api';
import { BandChip, RangeBar, Skeleton } from '../components/ui';
import { color, radius, space, type } from '../theme';

const BAND_FOR: Record<MealLog['status'], 'high' | 'medium' | 'low'> = {
  confirmed: 'high',
  needs_review: 'medium',
  needs_input: 'low',
};

export function HistoryScreen({ onOpen }: { onOpen: (log: MealLog) => void }) {
  const [meals, setMeals] = useState<MealLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.history();
      setMeals(res.meals);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach mise. Check that the API is running.',
      );
      setMeals([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => { setRefreshing(false); });
  }, [load]);

  // Skeletons rather than a spinner: the shape of what is coming is already
  // known, so showing it is less jarring than an empty screen with a wheel.
  if (meals === null) {
    return (
      <ScrollView contentContainerStyle={s.content}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={s.skeletonRow}>
            <Skeleton height={19} width="55%" />
            <Skeleton height={13} width="35%" />
            <Skeleton height={10} />
          </View>
        ))}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.primary} />}
    >
      {error && (
        <View style={s.error} accessibilityLiveRegion="polite">
          <Text style={[type.small, { color: color.ink }]}>{error}</Text>
        </View>
      )}

      {meals.length === 0 && !error ? (
        <View style={s.empty}>
          <Text style={[type.heading, { color: color.ink }]}>No meals yet</Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: space.sm }]}>
            Log one from the other tab. Every meal you log here keeps its full
            trace, so you can come back and see exactly which database row and
            which portion assumption produced each number.
          </Text>
          <Text style={[type.small, { color: color.inkMuted, marginTop: space.md }]}>
            Correcting a match teaches mise your wording. The same phrase
            resolves instantly next time, without asking a model.
          </Text>
        </View>
      ) : (
        meals.map((meal) => (
          <Pressable
            key={meal.id}
            onPress={() => { onOpen(meal); }}
            accessibilityRole="button"
            accessibilityLabel={`${Math.round(meal.totals.likely.kcal)} calories, ${meal.items.length} items`}
            style={({ pressed }) => [s.row, pressed && { backgroundColor: color.surface }]}
          >
            <View style={s.rowTop}>
              <Text style={[type.bodyStrong, { color: color.ink, flex: 1 }]} numberOfLines={1}>
                {meal.items.map((i) => i.foodName ?? i.extracted.phrase).join(', ') || 'Empty log'}
              </Text>
              <Text style={[type.bodyStrong, { color: color.ink }]}>
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
                <RangeBar
                  compact
                  min={meal.totals.min.kcal}
                  likely={meal.totals.likely.kcal}
                  max={meal.totals.max.kcal}
                />
              </View>
            )}
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: space.xl, paddingBottom: space.xxxl, gap: space.md },
  skeletonRow: {
    gap: space.sm,
    paddingVertical: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  row: {
    paddingVertical: space.lg,
    paddingHorizontal: space.md,
    marginHorizontal: -space.md,
    borderRadius: radius.md,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
    gap: space.sm,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowRange: { marginTop: space.xs },
  empty: { paddingVertical: space.xxl },
  error: { padding: space.md, borderRadius: radius.md, backgroundColor: color.reviewSoft },
});
