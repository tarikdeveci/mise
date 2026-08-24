import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api, ApiError, type MealLog, type ScannedProduct } from '../api';
import { Button } from '../components/ui';
import { color, numeric, radius, space, type } from '../theme';

/**
 * Barcode scan.
 *
 * This is the top rung of the portion ladder and the only path through the
 * whole product with no model in it: the barcode identifies the item exactly
 * and the label states the nutrition, so both the identification error and the
 * portion error go to roughly zero. It answers in milliseconds where the photo
 * path takes ten to thirty seconds.
 *
 * The scan is still confirmed before it is logged. A barcode is exact, but
 * "exact about the wrong item on the shelf" is still wrong, and the label
 * rarely knows how much of the package was actually eaten.
 */

interface Props {
  onLogged: (log: MealLog) => void;
  onClose: () => void;
}

const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e'] as const;

export function ScanScreen({ onLogged, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [found, setFound] = useState<ScannedProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servings, setServings] = useState(1);
  // The camera fires continuously while a barcode is in frame; without this the
  // same code would be looked up dozens of times a second.
  const claimed = useRef<string | null>(null);

  const onScanned = useCallback(async ({ data }: { data: string }) => {
    if (claimed.current || busy) return;
    claimed.current = data;
    setBusy(true);
    setError(null);
    try {
      setFound(await api.scan(data));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not look that barcode up.');
      claimed.current = null;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const log = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      onLogged(await api.logMeal({
        barcode: found.barcode,
        ...(servings !== 1 ? { text: `${servings} servings` } : {}),
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log that.');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { claimed.current = null; setFound(null); setError(null); setServings(1); };

  if (!permission) {
    return <View style={s.center}><ActivityIndicator color={color.signal} /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={s.center}>
        <Text style={[type.title, { color: color.ink, textAlign: 'center' }]}>
          Scanning needs the camera
        </Text>
        <Text style={[type.small, { color: color.inkMuted, textAlign: 'center', marginTop: space.sm }]}>
          A scanned label is the most accurate way to log a packaged food: no
          estimating, and a source you can check.
        </Text>
        <Button label="Allow camera" onPress={() => { void requestPermission(); }} style={s.wide} />
        <Button label="Go back" variant="ghost" onPress={onClose} style={s.wide} />
      </View>
    );
  }

  const perServing = found && found.servingGrams
    ? Math.round((found.per100g.kcal * found.servingGrams) / 100)
    : null;

  return (
    <View style={s.root}>
      {!found && (
        <>
          <CameraView
            style={s.camera}
            barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
            onBarcodeScanned={(e) => { void onScanned(e); }}
          />
          <View style={s.reticle} pointerEvents="none" />
          <View style={s.hint}>
            <Text style={[type.smallStrong, { color: color.ink, textAlign: 'center' }]}>
              Point at the barcode
            </Text>
            <Text style={[type.small, { color: color.inkMuted, textAlign: 'center', marginTop: 2 }]}>
              A label is exact. Nothing is estimated on this path.
            </Text>
          </View>
        </>
      )}

      {busy && !found && (
        <View style={s.working}><ActivityIndicator color={color.signal} /></View>
      )}

      {found && (
        <View style={s.result}>
          <Text style={[type.label, { color: color.ok }]}>FROM THE LABEL</Text>
          <Text style={[type.title, { color: color.ink, marginTop: space.xs }]}>{found.name}</Text>

          <View style={s.figures}>
            <Text style={[type.readout, numeric, { color: color.ink, fontSize: 44, lineHeight: 48 }]}>
              {perServing ?? found.per100g.kcal}
            </Text>
            <Text style={[type.body, { color: color.inkMuted, marginBottom: 8 }]}>
              kcal {found.servingGrams ? `per ${found.servingGrams} g serving` : 'per 100 g'}
            </Text>
          </View>

          <Text style={[type.small, { color: color.inkMuted }]}>
            How many {found.servingGrams ? 'servings' : 'hundred-gram portions'}?
          </Text>
          <View style={s.steppers}>
            {[0.5, 1, 1.5, 2, 3].map((n) => (
              <Pressable
                key={n}
                onPress={() => { setServings(n); }}
                accessibilityRole="button"
                accessibilityState={{ selected: servings === n }}
                style={({ pressed }) => [
                  s.stepper,
                  servings === n && { backgroundColor: color.signal, borderColor: color.signal },
                  pressed && servings !== n && { backgroundColor: color.raised },
                ]}
              >
                <Text style={[type.smallStrong, numeric, {
                  color: servings === n ? color.onSignal : color.ink,
                }]}>{n}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[type.label, { color: color.inkFaint, marginTop: space.lg }]}>
            {found.source}
          </Text>

          <Button
            label={busy ? 'Logging' : 'Log this'}
            onPress={() => { void log(); }}
            loading={busy}
            style={{ marginTop: space.lg }}
          />
          <Button label="Scan another" variant="ghost" onPress={reset} style={{ marginTop: space.sm }} />
        </View>
      )}

      {error && (
        <View style={s.error} accessibilityLiveRegion="polite">
          <Text style={[type.small, { color: color.ink }]}>{error}</Text>
          <Pressable onPress={reset} hitSlop={10}>
            <Text style={[type.smallStrong, { color: color.signal, marginTop: space.xs }]}>
              Try again
            </Text>
          </Pressable>
        </View>
      )}

      {!found && (
        <Button label="Cancel" variant="ghost" onPress={onClose} style={s.cancel} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  wide: { marginTop: space.md },
  camera: { ...StyleSheet.absoluteFillObject },
  reticle: {
    position: 'absolute',
    top: '30%', left: '12%', right: '12%', height: 150,
    borderWidth: 2,
    borderColor: color.signal,
    borderRadius: radius.md,
  },
  hint: {
    position: 'absolute',
    top: '30%',
    left: space.xl, right: space.xl,
    marginTop: 168,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.bg + 'e6',
  },
  working: { position: 'absolute', bottom: 120, alignSelf: 'center' },
  result: { flex: 1, padding: space.xl, justifyContent: 'center' },
  figures: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, marginVertical: space.lg },
  steppers: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  stepper: {
    minWidth: 52, minHeight: 44,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1, borderColor: color.lineStrong,
  },
  error: {
    position: 'absolute', bottom: 96, left: space.xl, right: space.xl,
    padding: space.md, borderRadius: radius.md, backgroundColor: color.raised,
  },
  cancel: { position: 'absolute', bottom: space.xl, left: space.xl, right: space.xl },
});
