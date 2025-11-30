# Effect CLI Skeleton

A CLI application built with [Effect](https://effect.website/) and [@effect/cli](https://www.effect.solutions/cli).

## Installation

```bash
bun install
```

## Usage

Run the CLI:

```bash
# Default greeting
bun index.ts
# Hello, World!

# Greet someone
bun index.ts Alice
# Hello, Alice!

# Shout the greeting
bun index.ts --shout Bob
# HELLO, BOB!

# Show help
bun index.ts --help

# Show version
bun index.ts --version
```

## Development

```bash
# Run with hot reload
bun run dev

# Type check
bun run typecheck

# Run
bun run start
```

## Project Structure

This is a minimal Effect CLI skeleton based on the [Effect Solutions CLI guide](https://www.effect.solutions/cli).

The CLI demonstrates:
- ✅ Typed argument parsing with `Args.text`
- ✅ Boolean flags with `Options.boolean`
- ✅ Default values with `Args.withDefault`
- ✅ Option aliases with `Options.withAlias`
- ✅ Automatic help generation
- ✅ Version flag
- ✅ Integration with Effect runtime

## Next Steps

To build your RPC client CLI:

1. **Read the CLI guide**: `effect-solutions show cli`
2. **Add RPC client logic**: Connect to your Effect RPC server
3. **Add more commands**: Use `Command.withSubcommands` for multiple commands
4. **Add services**: Create services for business logic (see `effect-solutions show services-and-layers`)
5. **Add error handling**: Use Schema.TaggedError for typed errors (see `effect-solutions show error-handling`)

## Resources

- [Effect Solutions CLI Guide](https://www.effect.solutions/cli)
- [Effect Documentation](https://effect.website/docs/introduction)
- [Effect GitHub](https://github.com/Effect-TS/effect)
- Local Effect source: `~/src/github.com/Effect-TS/effect`

---

Built with [Bun](https://bun.com) and [Effect](https://effect.website/)
