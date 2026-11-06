import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { Header, type Mode } from "./components/Header.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { PlanningStub } from "./components/PlanningStub.js";
import { useServerEvents } from "./events.js";
import { useInstallation, useLogout, usePauseToggle, useSession } from "./queries.js";

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
  const authenticated = session.data?.authenticated ?? false;
  const installation = useInstallation(authenticated);
  const connected = useServerEvents(authenticated);
  const pause = usePauseToggle();
  const logout = useLogout();
  const [mode, setMode] = useState<Mode>("development");
  const now = useNow();

  if (session.isPending) return <main className="p-6 text-neutral-500">Загрузка…</main>;
  if (session.isError) {
    return (
      <main className="p-6 text-red-600" role="alert">
        Сервер недоступен: {session.error.message}
      </main>
    );
  }
  if (!authenticated) return <LoginScreen passwordSet={session.data.passwordSet} />;

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
      />
      {mode === "development" ? <Dashboard now={now} /> : <PlanningStub />}
    </>
  );
}
