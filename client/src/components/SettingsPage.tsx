import { useSettings, useSettingsUpdate } from "../queries.js";
import { SettingsForm } from "./SettingsForm.js";
import { Banner, Spinner } from "./ui.js";

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const settings = useSettings(true);
  const update = useSettingsUpdate();
  if (settings.isPending) {
    return (
      <main className="flex items-center gap-2 p-6 text-muted">
        <Spinner /> Загрузка…
      </main>
    );
  }
  if (settings.isError) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <Banner tone="danger" role="alert">
          Не удалось загрузить настройки: {settings.error.message}
        </Banner>
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
