# Contributing

Thanks for wanting to improve forkcaster. Issues and pull requests are welcome, including small ones: a clearer sentence, a broken cast page, a test for something that surprised you.

The project is MIT licensed. By contributing, you agree your work is licensed the same way.

## Before you start

Open an issue if you want to talk through a change first. That helps most when the idea is large, or when it touches how casts are fetched and rendered. A pull request is fine on its own for a focused fix.

Architecture and the data path live in [README.md](README.md). Read the part your change touches so the pull request stays aligned with how the site already works.

## Set up

You need [Bun](https://bun.sh).

```sh
bun install
```

Before you open a pull request:

```sh
bun run lint
bun run typecheck
bun test
```

`bun run build` is worth running when you change the landing page or the worker.

## A few things that save a round trip

- First-party UI is Preact. The React imports exist so `react-farcaster-embed` can run; new code should not add React.
- Cast pages are server-rendered. Cast data comes from Shim. Please leave `react-farcaster-embed` on the supplied `castData` so it never fetches on its own.
- Worker imports use explicit extensions, for example `./cast-page.tsx`.
- Keep secrets out of the diff. `.env*` and `.dev.vars*` stay local.

## Pull requests

Describe what changed and why. If you can, say how you checked it: which command you ran, or which cast URL you opened.

Be kind in review. Assume good intent, and expect the same in return.
