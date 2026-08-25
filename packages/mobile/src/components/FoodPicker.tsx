import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { api, ApiError, type FoodSearchHit } from '../api';
import { color, numeric, radius, space, type } from '../theme';

/**
 * Search the verified food vocabulary and pick one row out of it.
 *
 * Shared by the two places a person names a food themselves: correcting a line
 * mise got wrong, and adding one it never produced. Both need the same thing —
 * debounced search, a cancellable request, and a list where every entry is a
 * row with a citation behind it — and both must obey the same rule, which is
 * that free text is only ever a query. Nothing here can author a number: the
 * value handed back is a `foodId`, and nutrition is computed server-side from
 * the row it names.
 */

/** Below two characters the query matches most of the corpus. Not worth sending. */
const MIN_QUERY = 2;
/** Long enough that a typed word settles, short enough to feel like search. */
const DEBOUNCE_MS = 280;

interface Props {
  placeholder: string;
  busy?: boolean;
  /**
   * Save the pick. Resolving false leaves the query and results standing, so a
   * failed save can be retried on the same list rather than searched for again.
   *
   * `query` is what the person typed to find this row. Worth handing back: it
   * is their wording for the food, which is what an alias is keyed on.
   */
  onPick: (food: FoodSearchHit, query: string) => Promise<boolean>;
}

export function FoodPicker({ placeholder, busy, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < MIN_QUERY) {
      setResults([]);
      setSearching(false);
      setSearched(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      setError(null);
      void api.searchFoods(normalized, controller.signal)
        .then(({ foods }) => {
          if (controller.signal.aborted) return;
          setResults(foods);
          setSearched(true);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setResults([]);
          setSearched(true);
          setError(err instanceof ApiError ? err.message : 'Could not search foods. Try again.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const choose = async (food: FoodSearchHit): Promise<void> => {
    setSavingId(food.foodId);
    setError(null);
    const saved = await onPick(food, query.trim());
    setSavingId(null);
    if (!saved) return;
    setQuery('');
    setResults([]);
    setSearched(false);
  };

  return (
    <View>
      <View style={s.searchBox}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          placeholderTextColor={color.inkFaint}
          autoCorrect
          autoCapitalize="none"
          returnKeyType="search"
          editable={!busy && !savingId}
          accessibilityLabel="Search the food database"
          style={[type.body, s.input, { color: color.ink }]}
        />
        {searching && <ActivityIndicator color={color.signal} size="small" />}
      </View>

      {error && <Text style={[type.small, { color: color.danger, marginTop: space.sm }]}>{error}</Text>}

      {!error && searched && !searching && results.length === 0 && (
        <Text style={[type.small, { color: color.inkMuted, marginTop: space.sm }]}>
          No verified row found. Try a broader name or an English term.
        </Text>
      )}

      {results.length > 0 && (
        <View style={s.results}>
          {results.map((food) => {
            const display = food.localizedName ?? food.name;
            const showEnglish = food.localizedName && food.localizedName !== food.name;
            const saving = savingId === food.foodId;
            return (
              <Pressable
                key={food.foodId}
                onPress={() => { void choose(food); }}
                disabled={busy || savingId !== null}
                accessibilityRole="button"
                accessibilityLabel={`Use ${display}`}
                style={({ pressed }) => [
                  s.result,
                  pressed && { backgroundColor: color.raised },
                  (busy || (savingId !== null && !saving)) && { opacity: 0.42 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.smallStrong, { color: color.ink }]}>{display}</Text>
                  {showEnglish && (
                    <Text style={[type.label, { color: color.inkFaint, marginTop: 2 }]} numberOfLines={1}>
                      {food.name}
                    </Text>
                  )}
                  <Text style={[type.label, { color: color.inkFaint, marginTop: 3 }]} numberOfLines={1}>
                    {food.tier === 'curated' ? 'Mise verified' : 'USDA reference'} · {food.source}
                  </Text>
                </View>
                {saving ? (
                  <ActivityIndicator color={color.signal} size="small" />
                ) : (
                  <Text style={[type.mono, numeric, { color: color.inkMuted }]}>
                    {Math.round(food.kcalPer100g)}
                    <Text style={[type.label, { color: color.inkFaint }]}> /100g</Text>
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    marginTop: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.raised,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  input: { flex: 1, paddingVertical: space.sm, paddingRight: space.sm },
  results: { marginTop: space.sm },
  result: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
    borderRadius: radius.sm,
  },
});
