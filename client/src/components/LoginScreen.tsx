import { useState, type FormEvent } from "react";
import { useLogin } from "../queries.js";
import { Banner, Button, Card, cx, INPUT, Spinner } from "./ui.js";

export function LoginScreen({ passwordSet }: { passwordSet: boolean }) {
  const [password, setPassword] = useState("");
  const login = useLogin();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== "") login.mutate(password);
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <Card className="p-6">
      <Logo />
      {passwordSet ? (
        <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
          <label className="text-sm font-medium">
            Пароль Установки
            <input
              type="password"
              name="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={cx(INPUT, "mt-1.5")}
            />
          </label>
          {login.isError && (
            <Banner tone="danger" role="alert">
              {login.error.message}
            </Banner>
          )}
          <Button type="submit" variant="primary" disabled={login.isPending || password === ""}>
            {login.isPending && <Spinner />}
            Войти
          </Button>
        </form>
      ) : (
        <p className="mt-4 text-sm text-muted">
          Пароль Установки ещё не задан. Положите argon2-хеш в <code>AUTO_DEV_PASSWORD_HASH</code> (его печатает <code>npm run password-hash -- &lt;пароль&gt;</code>) и перезапустите
          Установку.
        </p>
      )}
      </Card>
    </main>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-mono text-sm font-bold text-accent-fg">
        ad
      </span>
      <h1 className="text-lg font-semibold">auto-dev</h1>
    </div>
  );
}
