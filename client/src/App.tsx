import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { Header, type Mode } from "./components/Header.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { PlanningStub } from "./components/PlanningStub.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SetupScreen } from "./components/SetupScreen.js";
import { useServerEvents } from "./events.js";
import { useInstallation, useLogout, usePauseToggle, useSession, useSetup } from "./queries.js";

// "Time since" on the cards moves once a minute; everything else moves on events.
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type Page = "dashboard" | "settings";

export function App() {
  const session = useSession();
  const setup = useSetup();
  const setupRequired = setup.data?.required ?? false;
  const authenticated = (session.data?.authenticated ?? false) && !setupRequired;
  const installation = useInstallation(authenticated);
  const connected = useServerEvents(authenticated);
  const pause = usePauseToggle();
  const logout = useLogout();
  const [mode, setMode] = useState<Mode>("development");
  const [page, setPage] = useState<Page>("dashboard");
  // The wizard stays on its "done" step until the human opens the dashboard.
  const [wizard, setWizard] = useState(false);
  useEffect(() => {
    if (setupRequired) setWizard(true);
  }, [setupRequired]);
  const now = useNow();

  if (session.isPending || setup.isPending) return <main className="p-6 text-neutral-500">Загрузка…</main>;
  if (session.isError || setup.isError) {
    const error = session.error ?? setup.error;
    return (
      <main className="p-6 text-red-600" role="alert">
        Сервер недоступен: {error?.message}
      </main>
    );
  }
  // Without a complete env file every entry leads to the wizard.
  if (setupRequired || wizard) return <SetupScreen status={setup.data} onFinish={() => setWizard(false)} />;
  if (!session.data.authenticated) return <LoginScreen passwordSet={session.data.passwordSet} />;

  return (
    <>
      <Header
        installation={installation.data}
        mode={mode}
        onMode={setMode}
        onPause={(paused) => pause.mutate({ paused })}
        pausePending={pause.isPending}
        connected={connected}
        now={now}
        onLogout={() => logout.mutate()}
        page={page}
        onPage={setPage}
      />
      {page === "settings" ? <SettingsPage onBack={() => setPage("dashboard")} /> : mode === "development" ? <Dashboard now={now} /> : <PlanningStub />}
    </>
  );
}
