import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
// React Native's own SafeAreaView is deprecated and iOS-only in practice; the
// community package is the supported path and actually reports insets on
// Android, where the status bar and gesture bar both need real padding.
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import {
  IBMPlexSans_400Regular, IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold, IBMPlexSans_700Bold,
} from '@expo-google-fonts/ibm-plex-sans';
import { IBMPlexMono_500Medium, IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono';
import { api, type MealLog } from './api';
import { LogScreen } from './screens/LogScreen';
import { ResultScreen } from './screens/ResultScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { color, numeric, space, type } from './theme';

type Tab = 'log' | 'history';

export default function App() {
  const [fontsLoaded] = useFonts({
    IBMPlexSans_400Regular, IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold, IBMPlexSans_700Bold,
    IBMPlexMono_500Medium, IBMPlexMono_600SemiBold,
  });

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <View style={s.booting}>
          <ActivityIndicator color={color.signal} />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

/**
 * Root shell.
 *
 * Two tabs and one pushed result view. A navigation library would add a
 * dependency and a bundle for a graph this small; when a third destination
 * appears, that trade flips.
 */
function Shell() {
  const [tab, setTab] = useState<Tab>('log');
  const [result, setResult] = useState<MealLog | null>(null);
  const [today, setToday] = useState<{ kcal: number; min: number; max: number; meals: number } | null>(null);
  const insets = useSafeAreaInsets();

  const refreshToday = useCallback(async () => {
    try {
      const { meals } = await api.history(50);
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const todays = meals.filter((m) => new Date(m.createdAt) >= start);
      setToday({
        kcal: todays.reduce((sum, m) => sum + m.totals.likely.kcal, 0),
        min: todays.reduce((sum, m) => sum + m.totals.min.kcal, 0),
        max: todays.reduce((sum, m) => sum + m.totals.max.kcal, 0),
        meals: todays.length,
      });
    } catch {
      // The header is ambient information. If it cannot load, it says nothing
      // rather than pushing an error in front of someone trying to log a meal.
      setToday(null);
    }
  }, []);

  useEffect(() => { void refreshToday(); }, [refreshToday]);

  const onLogged = useCallback((log: MealLog) => {
    setResult(log);
    void refreshToday();
  }, [refreshToday]);

  const closeResult = useCallback(() => { setResult(null); }, []);

  return (
    <View style={s.root}>
      <ExpoStatusBar style="light" />

      {/* The instrument bar. It carries the identity on every screen rather
          than only after a meal is submitted, and it shows the one number a
          food diary exists to answer: where today stands, and how sure we are
          of it. */}
      <View style={[s.bar, { paddingTop: insets.top + space.md }]}>
        <View style={s.barRow}>
          <View>
            <Text style={[type.display, { color: color.readoutInk }]}>mise</Text>
            <Text style={[type.label, { color: color.readoutMuted, marginTop: 1 }]}>
              Shows its work
            </Text>
          </View>

          <View style={s.today}>
            {today === null ? (
              <Text style={[type.label, { color: color.readoutMuted }]}>—</Text>
            ) : (
              <>
                <Text style={[type.monoStrong, numeric, { color: color.readoutInk, fontSize: 26 }]}>
                  {Math.round(today.kcal)}
                </Text>
                <Text style={[type.label, { color: color.readoutMuted }]}>
                  {today.meals === 0
                    ? 'today'
                    : `today · ±${Math.round((today.max - today.min) / 2)}`}
                </Text>
              </>
            )}
          </View>
        </View>
      </View>

      <SafeAreaView style={s.body} edges={['bottom']}>
        {result ? (
          <ResultScreen log={result} onClose={closeResult} onUpdate={setResult} />
        ) : (
          <>
            <View style={s.tabs}>
              <TabButton label="Log a meal" active={tab === 'log'} onPress={() => { setTab('log'); }} />
              <TabButton label="History" active={tab === 'history'} onPress={() => { setTab('history'); }} />
            </View>

            {tab === 'log'
              ? <LogScreen onLogged={onLogged} />
              : <HistoryScreen onOpen={setResult} />}
          </>
        )}
      </SafeAreaView>
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        s.tab,
        active && s.tabActive,
        pressed && !active && { backgroundColor: color.surface },
      ]}
    >
      <Text style={[type.smallStrong, { color: active ? color.ink : color.inkFaint }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.readout },
  booting: { flex: 1, backgroundColor: color.readout, alignItems: 'center', justifyContent: 'center' },
  bar: {
    backgroundColor: color.readout,
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
  },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  today: { alignItems: 'flex-end' },
  body: { flex: 1, backgroundColor: color.bg },
  tabs: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.xl,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  tab: {
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: color.ink },
});
