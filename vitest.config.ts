import { defineConfig } from "vitest/config"
import { cpus } from "os"

const numCpus = cpus().length

export default defineConfig({
  test: {
    include: ["./test/**/*.test.ts"],
    globals: true,
    disableConsoleIntercept: true, // Show console.log during tests (for fixture path logging)

    // Parallelization settings for maximum speed
    // Use forks instead of threads - safer with native modules like node-pty
    pool: "forks",
    poolOptions: {
      forks: {
        // Use all available CPUs for parallel execution
        // Start more forks eagerly for faster parallelism
        minForks: numCpus,
        maxForks: numCpus,
        // Isolate each test file for safety
        isolate: true
      }
    },

    // File-level parallelism - run all test files in parallel
    fileParallelism: true,

    // Run tests within each file concurrently
    // Tests must be independent (each gets unique testDir, ports, etc.)
    sequence: {
      concurrent: true
    },

    // Faster test timeouts (fail fast)
    testTimeout: 60000, // 60s default
    hookTimeout: 30000, // 30s for hooks

    coverage: {
      provider: "v8"
    }
  }
})
