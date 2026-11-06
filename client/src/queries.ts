import { QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DigestResponse, InstallationResponse, PauseRequest, SessionResponse, TasksResponse } from "../../src/server/api-types.js";
import { api, ApiError } from "./api.js";

export const KEYS = {
  session: ["session"] as const,
  installation: ["installation"] as const,
  tasks: ["tasks"] as const,
  digest: (since: string) => ["digest", since] as const,
};

// A 401 from any query means the session is gone: the login screen takes over without a reload.
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) {
          client.setQueryData<SessionResponse>(KEYS.session, (session) => ({ passwordSet: session?.passwordSet ?? true, authenticated: false }));
        }
      },
    }),
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  });
  return client;
}

export const useSession = () => useQuery({ queryKey: KEYS.session, queryFn: () => api<SessionResponse>("/api/session"), staleTime: Infinity });

export const useInstallation = (enabled: boolean) =>
  useQuery({ queryKey: KEYS.installation, queryFn: () => api<InstallationResponse>("/api/installation"), enabled, refetchInterval: 30_000 });

export const useTasks = (enabled: boolean) =>
  useQuery({ queryKey: KEYS.tasks, queryFn: () => api<TasksResponse>("/api/tasks"), enabled, refetchInterval: 30_000 });

export const useDigest = (since: string | null) =>
  useQuery({
    queryKey: KEYS.digest(since ?? ""),
    queryFn: () => api<DigestResponse>(`/api/digest?since=${encodeURIComponent(since ?? "")}`),
    enabled: since !== null,
  });

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api<SessionResponse>("/api/login", { method: "POST", json: { password } }),
    onSuccess: (session) => queryClient.setQueryData(KEYS.session, session),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<SessionResponse>("/api/logout", { method: "POST" }),
    onSuccess: (session) => {
      queryClient.setQueryData(KEYS.session, session);
      queryClient.removeQueries({ queryKey: KEYS.tasks });
      queryClient.removeQueries({ queryKey: KEYS.installation });
    },
  });
}

export function usePauseToggle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PauseRequest) => api<InstallationResponse>("/api/installation/pause", { method: "PUT", json: request }),
    onSuccess: (installation) => queryClient.setQueryData(KEYS.installation, installation),
  });
}
