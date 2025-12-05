import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["./test/**/*.test.ts"],
    globals: true,
    disableConsoleIntercept: true, // Show console.log during tests (for fixture path logging)
    coverage: {
      provider: "v8"
    }
  }
})
