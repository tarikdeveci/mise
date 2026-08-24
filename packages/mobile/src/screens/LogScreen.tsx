import { useState } from 'react';
import {
  Image, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, ApiError, type MealLog } from '../api';
import { Button } from '../components/ui';
import { color, radius, space, type } from '../theme';

/** Real phrasings, deliberately messy — they teach the input by example. */
const EXAMPLES = [
  '2 dilim ekmek, peynir ve çay',
  'menemen ve bir bardak ayran',
  '180g grilled chicken with rice',
  'bir avuç badem',
];

interface Props {
  onLogged: (log: MealLog) => void;
}

export function LogScreen({ onLogged }: Props) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; base64: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = (text.trim().length > 0 || photo !== null) && !busy;

  const pickPhoto = async (source: 'camera' | 'library') => {
    setError(null);
    try {
      const permission = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setError(
          source === 'camera'
            ? 'mise needs camera access to read a meal photo. You can enable it in Settings, or just type what you ate.'
            : 'mise needs photo access to read a meal photo. You can enable it in Settings, or just type what you ate.',
        );
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

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const log = await api.logMeal({
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(photo ? { imageBase64: photo.base64, imageMediaType: photo.mime } : {}),
      });
      setText('');
      setPhoto(null);
      onLogged(log);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach mise. Check that the API is running, then try again.',
      );
    } finally {
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
        <Text style={[type.heading, { color: color.ink }]}>What did you eat?</Text>
        <Text style={[type.small, { color: color.inkMuted, marginTop: space.xs }]}>
          Type it however you say it. Turkish or English, exact grams or a rough guess.
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

        <View style={s.examples}>
          {EXAMPLES.map((ex) => (
            <Pressable
              key={ex}
              onPress={() => { setText(ex); }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Use example: ${ex}`}
              style={({ pressed }) => [s.example, pressed && { backgroundColor: color.primarySoft }]}
            >
              <Text style={[type.small, { color: color.inkMuted }]}>{ex}</Text>
            </Pressable>
          ))}
        </View>

        {photo ? (
          <View style={s.photoWrap}>
            <Image source={{ uri: photo.uri }} style={s.photo} accessibilityLabel="Selected meal photo" />
            <Pressable
              onPress={() => { setPhoto(null); }}
              accessibilityRole="button"
              accessibilityLabel="Remove photo"
              style={({ pressed }) => [s.removePhoto, pressed && { backgroundColor: color.surfaceSunk }]}
            >
              <Text style={[type.smallStrong, { color: color.ink }]}>Remove photo</Text>
            </Pressable>
          </View>
        ) : (
          <View style={s.photoButtons}>
            <Button
              label="Take a photo"
              variant="secondary"
              onPress={() => { void pickPhoto('camera'); }}
              disabled={busy}
              style={s.flex}
            />
            <Button
              label="Choose photo"
              variant="secondary"
              onPress={() => { void pickPhoto('library'); }}
              disabled={busy}
              style={s.flex}
            />
          </View>
        )}

        {error && (
          <View style={s.error} accessibilityLiveRegion="polite">
            <Text style={[type.small, { color: color.ink }]}>{error}</Text>
          </View>
        )}

        <Button
          label={busy ? 'Reading your meal' : 'Log this meal'}
          onPress={() => { void submit(); }}
          loading={busy}
          disabled={!canSubmit}
          style={{ marginTop: space.xl }}
        />

        <Text style={[type.small, { color: color.inkFaint, marginTop: space.md, textAlign: 'center' }]}>
          mise shows a calorie range, not a single number, and tells you where every figure came from.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.xl, paddingBottom: space.xxxl },
  input: {
    marginTop: space.lg,
    minHeight: 108,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bg,
    color: color.ink,
    textAlignVertical: 'top',
  },
  examples: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  example: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
  },
  photoButtons: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  photoWrap: { marginTop: space.lg, gap: space.md },
  photo: { width: '100%', height: 200, borderRadius: radius.md, backgroundColor: color.surfaceSunk },
  removePhoto: {
    alignSelf: 'flex-start',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
  },
  error: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.reviewSoft,
  },
});
