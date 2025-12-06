import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["./test/**/*.test.ts"],
    // TTY tests require node-pty native bindings which may not be available in CI
    exclude: process.env.CI ? ["./test/tty.e2e.test.ts"] : [],
    globals: true,
    disableConsoleIntercept: true, // Show console.log during tests (for fixture path logging)
    coverage: {
      provider: "v8"
    }
  }
})
