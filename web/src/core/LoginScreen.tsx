import { useState, type FormEvent } from "react";
import { ApiError } from "./api";
import { usePanel } from "./store";

/** Shown when no repo is chosen yet, or the API answered 401. */
export function LoginScreen() {
  const { repo, setRepo, needsLogin, login } = usePanel();
  const [repoInput, setRepoInput] = useState(repo);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (repoInput.trim() !== repo) setRepo(repoInput);
      if (needsLogin) await login(password);
      setPassword("");
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 401 ? "Wrong password." : x instanceof ApiError && x.status === 429 ? "Too many attempts. Wait a bit." : "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border p-6"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <h1 className="text-lg font-semibold">Blueprint Panel</h1>
        <label className="flex flex-col gap-1 text-sm">
          Repository
          <input
            className="mono rounded border px-2 py-1"
            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            placeholder="owner/name"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            autoComplete="off"
          />
        </label>
        {needsLogin && (
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              className="rounded border px-2 py-1"
              style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
        )}
        {err && (
          <p role="alert" style={{ color: "var(--danger)" }}>
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || repoInput.trim() === "" || (needsLogin && password === "")}
          className="rounded px-3 py-1.5 font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {needsLogin ? "Sign in" : "Open"}
        </button>
      </form>
    </main>
  );
}
