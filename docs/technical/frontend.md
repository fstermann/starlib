# Frontend

The frontend is a **Next.js** application built with React, TypeScript, and shadcn/ui.

## Setup

```bash
cd frontend
npm install
npm run dev
```

The app is available at `http://localhost:3000`.

## Project structure

```
frontend/src/
├── app/               # Next.js app router
│   ├── layout.tsx     # Root layout
│   ├── page.tsx       # Home page
│   ├── auth/          # OAuth callback page
│   ├── meta-editor/   # Metadata editor page
│   └── setup/         # Initial setup flow
├── components/        # UI components (shadcn/ui based)
├── generated/         # Auto-generated types from SoundCloud API
└── lib/               # Utilities and helpers
```

## Code generation

The SoundCloud API types in `src/generated/soundcloud.ts` are auto-generated from the [SoundCloud OpenAPI spec](https://developers.soundcloud.com/docs/api/explorer/api.json) using [openapi-typescript](https://openapi-ts.dev/).

To regenerate:

```bash
npm run generate
```

!!! warning

    Do not edit `src/generated/soundcloud.ts` manually; it will be overwritten on regeneration.

## Key pages

| Route | Description |
|-------|-------------|
| `/` | Home / collection browser |
| `/auth/soundcloud/callback` | OAuth callback handler |
| `/meta-editor` | Track metadata editor |
| `/setup` | Initial setup and SoundCloud connection |
