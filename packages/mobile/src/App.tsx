import { useCallback, useState } from 'react';
import { Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import type { MealLog } from './api';
import { LogScreen } from './screens/LogScreen';
import { ResultScreen } from './screens/ResultScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { color, space, type } from './theme';

type Tab = 'log' | 'history';

/**
 * Root.
 *
 * Two tabs and one pushed result view. A navigation library would add a
 * dependency and a bundle for a graph this small; when a third destination
 * appears, that trade flips.
 */
export default function App() {
  const [tab, setTab] = useState<Tab>('log');
  const [result, setResult] = useState<MealLog | null>(null);

  const onLogged = useCallback((log: MealLog) => { setResult(log); }, []);
  const closeResult = useCallback(() => { setResult(null); }, []);

  return (
    <SafeAreaView style={s.root}>
      <ExpoStatusBar style="dark" />

      {result ? (
        <ResultScreen log={result} onClose={closeResult} onUpdate={setResult} />
      ) : (
        <>
          <View style={s.header}>
            <Text style={[type.display, { color: color.ink }]}>mise</Text>
            <Text style={[type.small, { color: color.inkMuted, marginTop: 2 }]}>
              Logs what you ate, and shows its work.
            </Text>
          </View>

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
      <Text style={[type.smallStrong, { color: active ? color.ink : color.inkMuted }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
  },
  header: { paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.lg },
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
  tabActive: { borderBottomColor: color.primary },
});
