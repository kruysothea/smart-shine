# SmartShine

AI agents monitor, local models, and full Mac optimization suite — cleanup, speed, malware scan, app manager, duplicates, cloud & Space Lens.

Built with [Electron](https://www.electronjs.org/).

## Features

- **AI agent & token monitor** — track AI agent activity and billable token usage across the month
- **Local models** — manage locally installed models
- **Cleanup** — find and remove junk files and duplicates
- **Speed** — system optimization tools
- **Protection** — malware scanning
- **App manager** — manage installed applications and extensions
- **External drives** — mount/eject and health monitoring
- **Cloud & Space Lens** — storage insight and cloud overview

## Requirements

- macOS (Apple Silicon / arm64)
- [Node.js](https://nodejs.org/) and npm

## Getting started

```bash
# Install dependencies
npm install

# Run the app in development
npm run dev
```

## Building

Build a distributable `.dmg` and `.zip` for Apple Silicon:

```bash
npm run dist
```

Output is written to the `dist/` directory.

## Tests

Tests use Node's built-in test runner:

```bash
node --test tests/
```

## License

MIT © kruysothea
