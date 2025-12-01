import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { $ } from "bun"

// =============================================================================
// E2E Tests Configuration
// =============================================================================

const TEST_TASKS_FILE = "test-tasks.json"
const TEST_PID_FILE = "test-server.pid"
// const TEST_PORT = 3099 // Available for future use

// Parse args respecting quoted strings
const parseArgs = (args: string): string[] => {
  const result: string[] = []
  let current = ""
  let inQuotes = false
  let quoteChar = ""
  
  for (const char of args) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true
      quoteChar = char
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false
      quoteChar = ""
    } else if (char === " " && !inQuotes) {
      if (current) {
        result.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }
  if (current) result.push(current)
  return result
}

// Helper to run CLI with test configuration
const cli = (args: string) => {
  const argsList = parseArgs(args)
  return $`TASKS_FILE=${TEST_TASKS_FILE} bun cli.ts ${argsList}`.nothrow()
}

const cliText = async (args: string) => {
  const argsList = parseArgs(args)
  const result = await $`TASKS_FILE=${TEST_TASKS_FILE} bun cli.ts ${argsList}`.nothrow()
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode
  }
}

// Helper to clean up test files
const cleanup = async () => {
  await $`rm -f ${TEST_TASKS_FILE} ${TEST_PID_FILE}`.nothrow().quiet()
}

// =============================================================================
// Server Management E2E Tests
// =============================================================================

describe("Server Management E2E", () => {
  beforeEach(async () => {
    // Ensure server is stopped before each test
    await $`bun cli.ts server stop`.nothrow().quiet()
    await cleanup()
  })

  afterAll(async () => {
    await $`bun cli.ts server stop`.nothrow().quiet()
    await cleanup()
  })

  test("server status shows not running when stopped", async () => {
    const result = await cliText("server status")
    expect(result.stdout).toContain("not running")
  })

  test("server start -d creates PID file", async () => {
    await $`bun cli.ts server start -d`.quiet()
    
    // Wait for server to start
    await Bun.sleep(1000)
    
    const pidExists = await Bun.file("server.pid").exists()
    expect(pidExists).toBe(true)
    
    // Cleanup
    await $`bun cli.ts server stop`.quiet()
  })

  test("server status shows running after start", async () => {
    await $`bun cli.ts server start -d`.quiet()
    await Bun.sleep(1000)
    
    const result = await cliText("server status")
    expect(result.stdout).toContain("running")
    expect(result.stdout).toContain("PID")
    
    // Cleanup
    await $`bun cli.ts server stop`.quiet()
  })

  test("server stop removes PID file", async () => {
    await $`bun cli.ts server start -d`.quiet()
    await Bun.sleep(1000)
    
    await $`bun cli.ts server stop`.quiet()
    await Bun.sleep(500)
    
    const pidExists = await Bun.file("server.pid").exists()
    expect(pidExists).toBe(false)
  })

  test("server restart works correctly", async () => {
    // Start server first
    await $`bun cli.ts server start -d`.quiet()
    await Bun.sleep(1000)
    
    // Restart
    await $`bun cli.ts server restart -d`.quiet()
    await Bun.sleep(1500)
    
    // Check new PID is different (or server is still running)
    const pidExists = await Bun.file("server.pid").exists()
    expect(pidExists).toBe(true)
    
    // Cleanup
    await $`bun cli.ts server stop`.quiet()
  })
})

// =============================================================================
// Task Operations E2E Tests
// =============================================================================

describe("Task Operations E2E", () => {
  beforeAll(async () => {
    await cleanup()
    // Start server for task tests
    await $`TASKS_FILE=${TEST_TASKS_FILE} bun cli.ts server start -d`.quiet()
    await Bun.sleep(1500) // Wait for server to be ready
  })

  afterAll(async () => {
    await $`bun cli.ts server stop`.quiet()
    await cleanup()
  })

  beforeEach(async () => {
    // Clear tasks before each test
    await cli("tasks clear").quiet()
  })

  test("tasks list shows no tasks initially", async () => {
    const result = await cliText("tasks list")
    expect(result.stdout).toContain("No tasks")
  })

  test("tasks add creates a new task", async () => {
    const result = await cliText('tasks add "Buy groceries"')
    expect(result.stdout).toContain("Added task")
    expect(result.stdout).toContain("#1")
    expect(result.stdout).toContain("Buy groceries")
  })

  test("tasks list shows added task", async () => {
    await cli('tasks add "Test task"').quiet()
    
    const result = await cliText("tasks list")
    expect(result.stdout).toContain("Test task")
    expect(result.stdout).toContain("[ ]") // Not done
    expect(result.stdout).toContain("#1")
  })

  test("tasks toggle marks task as done", async () => {
    await cli('tasks add "Task to toggle"').quiet()
    
    const toggleResult = await cliText("tasks toggle 1")
    expect(toggleResult.stdout).toContain("Toggled")
    expect(toggleResult.stdout).toContain("done")
    
    // Verify with list --all
    const listResult = await cliText("tasks list --all")
    expect(listResult.stdout).toContain("[x]") // Done
  })

  test("tasks toggle twice marks task as pending again", async () => {
    await cli('tasks add "Toggle twice"').quiet()
    
    // Toggle to done
    await cli("tasks toggle 1").quiet()
    
    // Toggle back to pending
    const result = await cliText("tasks toggle 1")
    expect(result.stdout).toContain("pending")
  })

  test("tasks list hides completed tasks by default", async () => {
    await cli('tasks add "Done task"').quiet()
    await cli("tasks toggle 1").quiet()
    
    const result = await cliText("tasks list")
    expect(result.stdout).toContain("No tasks")
  })

  test("tasks list --all shows completed tasks", async () => {
    await cli('tasks add "Completed task"').quiet()
    await cli("tasks toggle 1").quiet()
    
    const result = await cliText("tasks list --all")
    expect(result.stdout).toContain("Completed task")
    expect(result.stdout).toContain("[x]")
  })

  test("tasks clear removes all tasks", async () => {
    await cli('tasks add "Task 1"').quiet()
    await cli('tasks add "Task 2"').quiet()
    await cli('tasks add "Task 3"').quiet()
    
    const clearResult = await cliText("tasks clear")
    expect(clearResult.stdout).toContain("Cleared")
    expect(clearResult.stdout).toContain("3")
    
    // Verify tasks are gone
    const listResult = await cliText("tasks list --all")
    expect(listResult.stdout).toContain("No tasks")
  })

  test("multiple tasks have sequential IDs", async () => {
    await cli('tasks add "First"').quiet()
    await cli('tasks add "Second"').quiet()
    await cli('tasks add "Third"').quiet()
    
    const result = await cliText("tasks list")
    expect(result.stdout).toContain("#1")
    expect(result.stdout).toContain("#2")
    expect(result.stdout).toContain("#3")
  })
})

// =============================================================================
// Error Handling E2E Tests
// =============================================================================

describe("Error Handling E2E", () => {
  beforeAll(async () => {
    await cleanup()
    await $`TASKS_FILE=${TEST_TASKS_FILE} bun cli.ts server start -d`.quiet()
    await Bun.sleep(1500)
  })

  afterAll(async () => {
    await $`bun cli.ts server stop`.quiet()
    await cleanup()
  })

  beforeEach(async () => {
    await cli("tasks clear").quiet()
  })

  test("toggle nonexistent task shows TaskNotFoundError", async () => {
    const result = await cliText("tasks toggle 999")
    expect(result.stderr + result.stdout).toContain("TaskNotFoundError")
  })

  test("toggle with invalid ID shows error", async () => {
    // This should fail gracefully
    const result = await cli("tasks toggle abc").nothrow()
    expect(result.exitCode).not.toBe(0)
  })
})

// =============================================================================
// CLI Help E2E Tests
// =============================================================================

describe("CLI Help E2E", () => {
  test("--help shows usage information", async () => {
    const result = await cliText("--help")
    expect(result.stdout).toContain("tasks")
  })

  test("tasks --help shows task commands", async () => {
    const result = await cliText("tasks --help")
    expect(result.stdout).toContain("list")
    expect(result.stdout).toContain("add")
    expect(result.stdout).toContain("toggle")
    expect(result.stdout).toContain("clear")
  })

  test("server --help shows server commands", async () => {
    const result = await cliText("server --help")
    expect(result.stdout).toContain("start")
    expect(result.stdout).toContain("stop")
    expect(result.stdout).toContain("restart")
    expect(result.stdout).toContain("status")
  })
})

// =============================================================================
// Global Options E2E Tests
// =============================================================================

describe("Global Options E2E", () => {
  test("--server-url option is accepted", async () => {
    // Just verify the option is recognized
    const result = await cli("--server-url http://localhost:3000/rpc --help").nothrow()
    // Should not error on the option itself
    expect(result.exitCode === 0 || result.stdout.toString().includes("tasks")).toBe(true)
  })
})

