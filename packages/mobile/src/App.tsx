import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
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
import { ScanScreen } from './screens/ScanScreen';
import { color, numeric, space, type } from './theme';

type Tab = 'log' | 'history';
type Route = { kind: 'tabs' } | { kind: 'result'; log: MealLog } | { kind: 'scan' };

export default function App() {
  const [fontsLoaded] = useFonts({
    IBMPlexSans_400Regular, IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold, IBMPlexSans_700Bold,
    IBMPlexMono_500Medium, IBMPlexMono_600SemiBold,
  });

  return (
    <SafeAreaProvider>
      <ExpoStatusBar style="light" />
      {fontsLoaded ? <Shell /> : (
        <View style={s.booting}><ActivityIndicator color={color.signal} /></View>
      )}
    </SafeAreaProvider>
  );
}

interface Today { kcal: number; min: number; max: number; meals: number }

function Shell() {
  const [tab, setTab] = useState<Tab>('log');
  const [route, setRoute] = useState<Route>({ kind: 'tabs' });
  const [today, setToday] = useState<Today | null>(null);
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
      // Ambient information. If it cannot load it says nothing, rather than
      // pushing an error at someone who came here to log a meal.
      setToday(null);
    }
  }, []);

  useEffect(() => { void refreshToday(); }, [refreshToday]);

  const onLogged = useCallback((log: MealLog) => {
    setRoute({ kind: 'result', log });
    void refreshToday();
  }, [refreshToday]);

  const toTabs = useCallback(() => { setRoute({ kind: 'tabs' }); }, []);

  return (
    <View style={s.root}>
      <View style={[s.bar, { paddingTop: insets.top + space.md }]}>
        <View style={s.barRow}>
          <View>
            <Text style={[type.display, { color: color.ink }]}>mise</Text>
            <Text style={[type.label, { color: color.inkFaint, marginTop: 1 }]}>Shows its work</Text>
          </View>

          {/* The one number a food diary exists to answer, with the width of
              the doubt attached. Present on every screen so the identity is
              not something that only appears after you press Save. */}
          <View style={s.today}>
            {today === null ? (
              <Text style={[type.label, { color: color.inkFaint }]}>—</Text>
            ) : (
              <>
                <Text style={[type.monoStrong, numeric, { color: color.ink, fontSize: 26 }]}>
                  {Math.round(today.kcal)}
                </Text>
                <Text style={[type.label, { color: color.inkFaint }]}>
                  {today.meals === 0 ? 'today' : `today · ±${Math.round((today.max - today.min) / 2)}`}
                </Text>
              </>
            )}
          </View>
        </View>
      </View>

      <SafeAreaView style={s.body} edges={['bottom']}>
        {route.kind === 'result' ? (
          <ResultScreen
            log={route.log}
            onClose={toTabs}
            onUpdate={(log) => { setRoute({ kind: 'result', log }); void refreshToday(); }}
          />
        ) : route.kind === 'scan' ? (
          <ScanScreen onLogged={onLogged} onClose={toTabs} />
        ) : (
          <>
            <View style={s.tabs}>
              <TabButton label="Log a meal" active={tab === 'log'} onPress={() => { setTab('log'); }} />
              <TabButton label="History" active={tab === 'history'} onPress={() => { setTab('history'); }} />
            </View>

            {tab === 'log' ? (
              <LogScreen onLogged={onLogged} onScan={() => { setRoute({ kind: 'scan' }); }} />
            ) : (
              <HistoryScreen onOpen={(log) => { setRoute({ kind: 'result', log }); }} onLogged={onLogged} />
            )}
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
  root: { flex: 1, backgroundColor: color.bg },
  booting: { flex: 1, backgroundColor: color.bg, alignItems: 'center', justifyContent: 'center' },
  bar: { backgroundColor: color.bg, paddingHorizontal: space.xl, paddingBottom: space.lg },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  today: { alignItems: 'flex-end' },
  body: { flex: 1, backgroundColor: color.bg },
  tabs: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.xl,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  tab: {
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: color.signal },
});
