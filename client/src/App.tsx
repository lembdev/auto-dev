import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { Header, type Mode, type Page } from "./components/Header.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { PlanningStub } from "./components/PlanningStub.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SetupScreen } from "./components/SetupScreen.js";
import { StatsPage } from "./components/Stats.js";
import { useServerEvents } from "./events.js";
import { useClaudeRecheck, useInstallation, useLogout, usePauseToggle, useSession, useSetup, useStartUpdate } from "./queries.js";

// "Time since" on the cards moves once a minute; everything else moves on events.
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function App() {
  const session = useSession();
  const setup = useSetup();
  const setupRequired = setup.data?.required ?? false;
  const authenticated = (session.data?.authenticated ?? false) && !setupRequired;
  const installation = useInstallation(authenticated);
  const connected = useServerEvents(authenticated);
  const pause = usePauseToggle();
  const recheck = useClaudeRecheck();
  const startUpdate = useStartUpdate();
  const logout = useLogout();
  const [mode, setMode] = useState<Mode>("development");
  const [page, setPage] = useState<Page>("main");
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
        page={page}
        onPage={setPage}
        onPause={(paused) => pause.mutate({ paused })}
        pausePending={pause.isPending}
        onRecheck={() => recheck.mutate()}
        recheckPending={recheck.isPending}
        onUpdate={() => startUpdate.mutate()}
        updatePending={startUpdate.isPending}
        updateError={startUpdate.error?.message}
        connected={connected}
        now={now}
        onLogout={() => logout.mutate()}
      />
      {page === "settings" ? <SettingsPage onBack={() => setPage("main")} /> : page === "stats" ? <StatsPage now={now} /> : mode === "development" ? <Dashboard now={now} /> : <PlanningStub />}
    </>
  );
}
