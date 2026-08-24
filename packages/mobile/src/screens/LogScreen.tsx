import { useEffect, useRef, useState } from 'react';
import {
  Image, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, ApiError, TimeoutError, type MealLog, type ReferenceObject } from '../api';
import { Button } from '../components/ui';
import { color, radius, space, type } from '../theme';

/** Real phrasings, deliberately messy: they teach the input by example. */
const EXAMPLES = [
  '2 dilim ekmek, peynir ve çay',
  'menemen ve bir bardak ayran',
  '180g grilled chicken with rice',
  'bir avuç badem',
];

const REFERENCES: ReadonlyArray<readonly [ReferenceObject, string]> = [
  ['none', 'Nothing'],
  ['card', 'A card'],
  ['coin', 'A coin'],
  ['utensil', 'A fork'],
];

interface Props {
  onLogged: (log: MealLog) => void;
  onScan: () => void;
}

export function LogScreen({ onLogged, onScan }: Props) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; base64: string; mime: string } | null>(null);
  const [reference, setReference] = useState<ReferenceObject>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `null` while unknown: the camera is neither offered nor denied until the
  // server has said whether it can actually read a photo.
  const [vision, setVision] = useState<boolean | null>(null);
  // Held for the life of one submission so the user can call it off. A photo
  // legitimately takes tens of seconds; a wait nobody can escape is a different
  // problem to a wait that is long.
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    void api.health()
      .then((h) => { if (alive) setVision(h.visionAvailable); })
      .catch(() => { if (alive) setVision(null); });
    return () => { alive = false; };
  }, []);

  const canSubmit = (text.trim().length > 0 || photo !== null) && !busy;

  const pickPhoto = async (source: 'camera' | 'library') => {
    setError(null);
    try {
      const permission = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setError('mise needs that permission to read a meal photo. You can type what you ate instead.');
        return;
      }

      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6 });

      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.base64) {
        setError('That photo could not be read. Try another, or type what you ate.');
        return;
      }
      setPhoto({ uri: asset.uri, base64: asset.base64, mime: asset.mimeType ?? 'image/jpeg' });
    } catch {
      setError('Could not open the camera. You can type what you ate instead.');
    }
  };

  const cancel = () => {
    inFlight.current?.abort();
  };

  const submit = async () => {
    if (!canSubmit) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError(null);
    try {
      const log = await api.logMeal(
        {
          ...(text.trim() ? { text: text.trim() } : {}),
          ...(photo ? { imageBase64: photo.base64, imageMediaType: photo.mime } : {}),
          ...(photo && reference !== 'none' ? { reference } : {}),
        },
        undefined,
        controller.signal,
      );
      setText('');
      setPhoto(null);
      setReference('none');
      onLogged(log);
    } catch (err) {
      // Cancelling is not an error the user needs explained back to them; they
      // are the one who did it. Everything else gets a sentence they can act on.
      if (err instanceof TimeoutError && err.cancelled) return;
      setError(
        err instanceof TimeoutError || err instanceof ApiError
          ? err.message
          : 'Could not reach mise. Check that the API is running, then try again.',
      );
    } finally {
      inFlight.current = null;
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {/*
          The ways in, ordered by how well they actually work and labelled with
          it. Scanning is not buried behind an icon: it is the most accurate
          thing this app can do, because the label states the nutrition and no
          model is involved in identifying the product or reading the numbers.
        */}
        <Pressable
          onPress={onScan}
          accessibilityRole="button"
          accessibilityLabel="Scan a barcode. The most accurate way to log a packaged food."
          style={({ pressed }) => [s.scan, pressed && { backgroundColor: color.raised }]}
        >
          <View style={s.flex}>
            <Text style={[type.bodyStrong, { color: color.ink }]}>Scan a barcode</Text>
            <Text style={[type.small, { color: color.inkMuted, marginTop: 1 }]}>
              Packaged food, read off the label. Nothing guessed.
            </Text>
          </View>
          {/*
            The figure has to be the one the pipeline actually returns. It said
            "±0%" here while the barcode rung has always carried an 8% spread,
            and the backend was the one telling the truth: a printed serving is
            an exact number, but "I ate one serving" is not a measurement, and
            declared nutrients carry real labelling tolerance. Claiming zero on
            the single screen that sells this product on honesty was the worst
            place in the app to round a number in our own favour.
          */}
          <Text style={[type.label, { color: color.ok }]}>±8%</Text>
        </Pressable>

        <Text style={[type.title, { color: color.ink, marginTop: space.xl }]}>Or describe it</Text>
        <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
          However you say it. Turkish or English, exact grams or a rough guess.
        </Text>

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="2 dilim ekmek, peynir ve çay"
          placeholderTextColor={color.inkFaint}
          multiline
          style={[s.input, type.body]}
          accessibilityLabel="Meal description"
          editable={!busy}
        />

        <Text style={[type.label, { color: color.inkFaint, marginTop: space.lg }]}>
          Or try one of these
        </Text>
        <View style={s.examples}>
          {EXAMPLES.map((ex) => (
            <Pressable
              key={ex}
              onPress={() => { setText(ex); }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Use example: ${ex}`}
              style={({ pressed }) => [s.example, pressed && { backgroundColor: color.raised }]}
            >
              <Text style={[type.small, { color: color.inkMuted }]}>{ex}</Text>
            </Pressable>
          ))}
        </View>

        {photo ? (
          <View style={s.photoWrap}>
            <Image source={{ uri: photo.uri }} style={s.photo} accessibilityLabel="Selected meal photo" />

            {/*
              Asked here rather than before the shot, because the answer costs
              nothing and the gain is large: published work puts a plain card in
              frame at 34% -> 18% calorie error on a 2D photo.
            */}
            <Text style={[type.smallStrong, { color: color.ink }]}>
              Anything of known size in the shot?
            </Text>
            <View style={s.refRow}>
              {REFERENCES.map(([value, label]) => (
                <Pressable
                  key={value}
                  onPress={() => { setReference(value); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: reference === value }}
                  style={({ pressed }) => [
                    s.ref,
                    reference === value && { backgroundColor: color.signal, borderColor: color.signal },
                    pressed && reference !== value && { backgroundColor: color.raised },
                  ]}
                >
                  <Text style={[type.smallStrong, {
                    color: reference === value ? color.onSignal : color.ink,
                  }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={[type.small, { color: color.inkFaint }]}>
              {reference === 'none'
                ? 'Without a size reference the portion is a guess, so the range stays wide.'
                : 'That gives the estimate a scale to work from.'}
            </Text>

            <Pressable
              onPress={() => { setPhoto(null); setReference('none'); }}
              accessibilityRole="button"
              accessibilityLabel="Remove photo"
              style={({ pressed }) => [s.removePhoto, pressed && { backgroundColor: color.raised }]}
            >
              <Text style={[type.smallStrong, { color: color.inkMuted }]}>Remove photo</Text>
            </Pressable>
          </View>
        ) : vision === false ? (
          <View style={s.notice}>
            <Text style={[type.smallStrong, { color: color.ink }]}>Photos are off right now</Text>
            <Text style={[type.small, { color: color.inkMuted, marginTop: 2 }]}>
              This server is running the text-only extractor. Start the API with a
              vision provider key to log from a photo.
            </Text>
          </View>
        ) : (
          <View style={s.photoButtons}>
            <Button label="Take a photo" variant="secondary" style={s.flex}
              disabled={busy || vision === null} onPress={() => { void pickPhoto('camera'); }} />
            <Button label="Choose photo" variant="secondary" style={s.flex}
              disabled={busy || vision === null} onPress={() => { void pickPhoto('library'); }} />
          </View>
        )}

        {error && (
          <View style={s.error} accessibilityLiveRegion="polite">
            <Text style={[type.small, { color: color.ink }]}>{error}</Text>
          </View>
        )}

        <Button
          label={busy ? (photo ? 'Reading the photo' : 'Reading your meal') : 'Log this meal'}
          onPress={() => { void submit(); }}
          loading={busy}
          disabled={!canSubmit}
          style={{ marginTop: space.xl }}
        />

        {/*
          Only while something is actually in flight. A photo of several foods
          can spend tens of seconds at the verifier rung, which is a real cost
          the user should be able to decline rather than sit through.
        */}
        {busy && (
          <Pressable onPress={cancel} accessibilityRole="button" style={s.cancel}>
            <Text style={[type.small, { color: color.inkMuted }]}>
              {photo ? 'Photos take longer. Cancel' : 'Cancel'}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.xl, paddingBottom: space.xxxl },
  scan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
  },
  input: {
    marginTop: space.lg,
    minHeight: 120,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
    color: color.ink,
    textAlignVertical: 'top',
  },
  examples: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  example: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
  },
  photoButtons: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  cancel: { alignSelf: 'center', paddingVertical: space.md, paddingHorizontal: space.lg },
  photoWrap: { marginTop: space.lg, gap: space.md },
  photo: { width: '100%', height: 190, borderRadius: radius.md, backgroundColor: color.surface },
  refRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  ref: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  removePhoto: {
    alignSelf: 'flex-start',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.line,
  },
  notice: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  error: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.raised,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
});
