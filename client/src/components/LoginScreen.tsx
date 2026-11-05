import { useState, type FormEvent } from "react";
import { useLogin } from "../queries.js";

export function LoginScreen({ passwordSet }: { passwordSet: boolean }) {
  const [password, setPassword] = useState("");
  const login = useLogin();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== "") login.mutate(password);
  };
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-xl font-semibold">auto-dev</h1>
      {passwordSet ? (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
          <label className="text-sm">
            Пароль Установки
            <input
              type="password"
              name="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          {login.isError && (
            <div className="text-sm text-red-600" role="alert">
              {login.error.message}
            </div>
          )}
          <button type="submit" disabled={login.isPending || password === ""} className="rounded-md bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50">
            Войти
          </button>
        </form>
      ) : (
        <p className="mt-4 text-sm text-neutral-500">
          Пароль Установки ещё не задан. Положите argon2-хеш в <code>AUTO_DEV_PASSWORD_HASH</code> (его печатает <code>npm run password-hash -- &lt;пароль&gt;</code>) и перезапустите
          Установку.
        </p>
      )}
    </main>
  );
}
