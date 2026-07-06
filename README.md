# Helix

An AI-powered desktop application built with Next.js and Electron.

## Features

- **AI Agent Integration** — Chat with AI models through a built-in agent flow panel
- **MCP Server Support** — Connect to Model Context Protocol servers for extended capabilities
- **Skills System** — Installable skill plugins that extend functionality
- **Scheduled Tasks** — Automate recurring or one-time tasks
- **Desktop App** — Native Windows, macOS, and Linux support via Electron
- **CLI Tool** — Command-line interface for quick interactions

## Tech Stack

- **Frontend:** Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **Desktop:** Electron 43, electron-builder
- **State Management:** Zustand
- **UI Components:** Radix UI, Lucide Icons
- **Editor:** Monaco Editor (via @monaco-editor/react)
- **Markdown:** react-markdown
- **Validation:** Zod

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

Run the web application:

```bash
npm run dev
```

Run the Electron desktop app:

```bash
npm run electron
```

Run both concurrently (Next.js + Electron hot-reload):

```bash
npm run electron:dev
```

### Build

Build the production Next.js app:

```bash
npm run build
```

Build the Electron installer:

```bash
npm run electron:build
```

Preview the Electron app without packaging:

```bash
npm run electron:preview
```

### CLI

Use the built-in command-line interface:

```bash
npm run cli
```

## Project Structure

```
├── electron/          # Electron main & preload scripts
├── public/            # Static assets
├── scripts/           # Utility scripts (MCP init, etc.)
├── skills/            # Installed skill definitions
├── src/
│   ├── app/           # Next.js app router (API routes + pages)
│   └── components/    # React components
├── package.json
└── tailwind.config.ts
```

## License

Private
