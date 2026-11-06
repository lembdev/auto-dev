import { QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentHistoryResponse,
  CancelResponse,
  DialogueResponse,
  DigestResponse,
  InstallationResponse,
  InterruptResponse,
  LimitHistoryResponse,
  LogsResponse,
  PauseRequest,
  PlannerResponse,
  RemoveDialogueResponse,
  SessionResponse,
  SettingsRequest,
  SettingsResponse,
  SetupAccessResponse,
  SetupSmokeResponse,
  SetupStatus,
  StartPlannerRequest,
  StatsPeriodDays,
  StatsResponse,
  TasksResponse,
} from "../../src/server/api-types.js";
import { api, ApiError } from "./api.js";

export const KEYS = {
  session: ["session"] as const,
  setup: ["setup"] as const,
  settings: ["settings"] as const,
  installation: ["installation"] as const,
  tasks: ["tasks"] as const,
  digest: (since: string) => ["digest", since] as const,
  stats: (days: StatsPeriodDays) => ["stats", days] as const,
  limitHistory: (days: StatsPeriodDays) => ["stats", "limits", days] as const,
  logs: ["logs"] as const,
  dialogue: (issueNumber: number) => ["dialogue", issueNumber] as const,
  planner: ["planner"] as const,
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

export const useStats = (days: StatsPeriodDays, enabled = true) =>
  useQuery({ queryKey: KEYS.stats(days), queryFn: () => api<StatsResponse>(`/api/stats?days=${days}`), enabled, refetchInterval: 60_000 });

export const useLimitHistory = (days: StatsPeriodDays, enabled = true) =>
  useQuery({ queryKey: KEYS.limitHistory(days), queryFn: () => api<LimitHistoryResponse>(`/api/stats/limits?days=${days}`), enabled, refetchInterval: 60_000 });

export const useLogs = (enabled = true) =>
  useQuery({ queryKey: KEYS.logs, queryFn: () => api<LogsResponse>("/api/logs?lines=500"), enabled, refetchInterval: 15_000 });

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

// The wizard status is public: it decides whether the login screen or the wizard shows first.
export const useSetup = () => useQuery({ queryKey: KEYS.setup, queryFn: () => api<SetupStatus>("/api/setup"), staleTime: Infinity });

// One mutation per wizard step; each answers with the status that follows it.
export function useSetupStep<TVariables>(run: (variables: TVariables) => Promise<SetupStatus>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (status) => {
      queryClient.setQueryData(KEYS.setup, status);
      // The password step logs the human in; the session query must learn that.
      void queryClient.invalidateQueries({ queryKey: KEYS.session });
    },
  });
}

export const setupPassword = (password: string) => api<SetupStatus>("/api/setup/password", { method: "POST", json: { password } });
export const setupRepository = (input: { repo: string; token: string }) => api<SetupStatus>("/api/setup/repository", { method: "POST", json: input });
export const setupOauth = (token: string) => api<SetupStatus>("/api/setup/oauth", { method: "POST", json: { token } });
export const setupClone = () => api<SetupStatus>("/api/setup/clone", { method: "POST", json: {} });

export function useSetupCheck<TResponse extends { status: SetupStatus }>(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<TResponse>(path, { method: "POST", json: {} }),
    onSuccess: (response) => queryClient.setQueryData(KEYS.setup, response.status),
  });
}

export const useSetupAccessCheck = () => useSetupCheck<SetupAccessResponse>("/api/setup/access");
export const useSetupSmokeCheck = () => useSetupCheck<SetupSmokeResponse>("/api/setup/smoke");

export const useSettings = (enabled: boolean) => useQuery({ queryKey: KEYS.settings, queryFn: () => api<SettingsResponse>("/api/settings"), enabled });

export function useSettingsUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsRequest) => api<SettingsResponse>("/api/settings", { method: "PUT", json: patch }),
    onSuccess: (settings) => {
      queryClient.setQueryData(KEYS.settings, settings);
      void queryClient.invalidateQueries({ queryKey: KEYS.installation });
      void queryClient.invalidateQueries({ queryKey: KEYS.tasks });
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

// "Проверить снова" in the claude version banner: one more smoke query on the current CLI.
export function useClaudeRecheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<InstallationResponse>("/api/installation/claude/recheck", { method: "POST" }),
    onSuccess: (installation) => queryClient.setQueryData(KEYS.installation, installation),
  });
}

// "Обновить": the server starts the updater and answers at once; the phase then follows in the installation view.
export function useStartUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<InstallationResponse>("/api/installation/update", { method: "POST" }),
    onSuccess: (installation) => queryClient.setQueryData(KEYS.installation, installation),
  });
}

export const fetchAgentHistory = (issueNumber: number) => api<AgentHistoryResponse>(`/api/tasks/${issueNumber}/agent/history`);

// "Остановить ход": the Turn is interrupted, the Session stays; the card follows the `agent` event.
export function useInterrupt() {
  return useMutation({ mutationFn: (issueNumber: number) => api<InterruptResponse>(`/api/tasks/${issueNumber}/agent/interrupt`, { method: "POST" }) });
}

// "Отменить задачу": the issue is closed and the Task leaves the list of Tasks in progress.
export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueNumber: number) => api<CancelResponse>(`/api/tasks/${issueNumber}/cancel`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.tasks });
      void queryClient.invalidateQueries({ queryKey: KEYS.installation });
    },
  });
}

// The lines of the Dialogue of a Task still on their way to the Session; the `dialogue` event refetches it.
export const useDialogueQueue = (issueNumber: number) =>
  useQuery({ queryKey: KEYS.dialogue(issueNumber), queryFn: () => api<DialogueResponse>(`/api/tasks/${issueNumber}/dialogue`), refetchInterval: 30_000 });

// "удалить" next to a line: it never reaches the Session.
export function useRemoveDialogueMessage(issueNumber: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<RemoveDialogueResponse>(`/api/tasks/${issueNumber}/dialogue/${id}`, { method: "DELETE" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEYS.dialogue(issueNumber) }),
  });
}

// Planning mode

// The Planner and its queue; the `planner` event refetches it.
export const usePlanner = (enabled = true) => useQuery({ queryKey: KEYS.planner, queryFn: () => api<PlannerResponse>("/api/planner"), enabled, refetchInterval: 30_000 });

export const fetchPlannerHistory = () => api<AgentHistoryResponse>("/api/planner/history");

const usePlannerAction = <TVariables>(run: (variables: TVariables) => Promise<PlannerResponse>) => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: (planner) => queryClient.setQueryData(KEYS.planner, planner) });
};

// "Продолжить прошлую" or "Начать новую".
export const useStartPlanner = () => usePlannerAction((request: StartPlannerRequest) => api<PlannerResponse>("/api/planner/start", { method: "POST", json: request }));

// "Завершить планирование": the process goes, the Session stays for the next "продолжить".
export const useFinishPlanner = () => usePlannerAction((_: void) => api<PlannerResponse>("/api/planner/finish", { method: "POST", json: {} }));

export const useInterruptPlanner = () => usePlannerAction((_: void) => api<PlannerResponse>("/api/planner/interrupt", { method: "POST", json: {} }));

export function useRemovePlannerLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<RemoveDialogueResponse>(`/api/planner/queue/${id}`, { method: "DELETE" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEYS.planner }),
  });
}
