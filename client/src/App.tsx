import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { Header, type Mode, type Page } from "./components/Header.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { PlanningScreen } from "./components/PlanningScreen.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SetupScreen } from "./components/SetupScreen.js";
import { StatsPage } from "./components/Stats.js";
import { Banner, Spinner } from "./components/ui.js";
import { useServerEvents } from "./events.js";
import { useClaudeRecheck, useInstallation, useLogout, usePauseToggle, useRestartDrain, useSession, useSetup, useStartUpdate } from "./queries.js";

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
  const restart = useRestartDrain();
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

  if (session.isPending || setup.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-2 text-muted">
        <Spinner /> Загрузка…
      </main>
    );
  }
  if (session.isError || setup.isError) {
    const error = session.error ?? setup.error;
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center px-4">
        <Banner tone="danger" role="alert">
          Сервер недоступен: {error?.message}
        </Banner>
      </main>
    );
  }
  // Without a complete env file every entry leads to the wizard.
  if (setupRequired || wizard) return <SetupScreen status={setup.data} onFinish={() => setWizard(false)} />;
  if (!session.data.authenticated) return <LoginScreen passwordSet={session.data.passwordSet} />;

  // App shell: the header stays on top, the screen below scrolls on its own; the planning screen
  // fills the remaining height exactly, whatever banners the header shows.
  return (
    <div className="flex h-dvh flex-col">
      <Header
        installation={installation.data}
        mode={mode}
        onMode={setMode}
        page={page}
        onPage={setPage}
        onPause={(paused) => pause.mutate({ paused })}
        pausePending={pause.isPending}
        onRestart={(action) => restart.mutate(action)}
        restartPending={restart.isPending}
        onRecheck={() => recheck.mutate()}
        recheckPending={recheck.isPending}
        onUpdate={() => startUpdate.mutate()}
        updatePending={startUpdate.isPending}
        updateError={startUpdate.error?.message}
        connected={connected}
        now={now}
        onLogout={() => logout.mutate()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {page === "settings" ? <SettingsPage onBack={() => setPage("main")} /> : page === "stats" ? <StatsPage now={now} /> : mode === "development" ? <Dashboard now={now} /> : <PlanningScreen />}
      </div>
    </div>
  );
}
