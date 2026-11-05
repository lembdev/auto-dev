import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "client",
          include: ["client/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["client/src/test-setup.ts"],
        },
      },
    ],
  },
});
