import { useQueryClient } from "@tanstack/react-query";
import type { SetupStatus } from "../../../src/server/api-types.js";
import { KEYS, setupClone, setupOauth, setupPassword, setupRepository, useSetupAccessCheck, useSetupSmokeCheck, useSetupStep } from "../queries.js";
import { SetupWizard } from "./SetupWizard.js";

// Binds the wizard to the setup API: every step is a mutation that answers with the next status.
export function SetupScreen({ status, onFinish }: { status: SetupStatus; onFinish: () => void }) {
  const queryClient = useQueryClient();
  const password = useSetupStep(setupPassword);
  const repository = useSetupStep(setupRepository);
  const oauth = useSetupStep(setupOauth);
  const clone = useSetupStep(() => setupClone());
  const access = useSetupAccessCheck();
  const smoke = useSetupSmokeCheck();
  const mutations = [password, repository, oauth, clone, access, smoke];
  const busy = mutations.some((mutation) => mutation.isPending);
  const failed = mutations.find((mutation) => mutation.isError);
  return (
    <SetupWizard
      status={status}
      busy={busy}
      error={failed?.error.message ?? null}
      access={access.data ?? null}
      smoke={smoke.data ?? null}
      onPassword={(value) => password.mutate(value)}
      onRepository={(input) => repository.mutate(input)}
      onCheckAccess={() => access.mutate()}
      onOauth={(token) => oauth.mutate(token)}
      onSmoke={() => smoke.mutate()}
      onClone={() => clone.mutate(undefined)}
      onFinish={() => {
        void queryClient.invalidateQueries({ queryKey: KEYS.setup });
        void queryClient.invalidateQueries({ queryKey: KEYS.session });
        void queryClient.invalidateQueries({ queryKey: KEYS.installation });
        onFinish();
      }}
    />
  );
}
