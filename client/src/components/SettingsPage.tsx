import { useSettings, useSettingsUpdate } from "../queries.js";
import { SettingsForm } from "./SettingsForm.js";

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const settings = useSettings(true);
  const update = useSettingsUpdate();
  if (settings.isPending) return <main className="p-6 text-neutral-500">Загрузка…</main>;
  if (settings.isError) {
    return (
      <main className="p-6 text-red-600" role="alert">
        Не удалось загрузить настройки: {settings.error.message}
      </main>
    );
  }
  return (
    <SettingsForm
      key={JSON.stringify(settings.data)}
      settings={settings.data}
      busy={update.isPending}
      error={update.isError ? update.error.message : null}
      saved={update.isSuccess ? update.variables : null}
      onSave={(patch) => update.mutate(patch)}
      onBack={onBack}
    />
  );
}
