# Repository Guidelines

## Project Structure & Module Organization

The application is intentionally small. `app/app.py` contains the Flask routes, Base62 helpers, Redis cache access, PostgreSQL queries, and rate limiter. `app/init.sql` defines the `urls` table. `app/Dockerfile` and `app/requirements.txt` build the Python service. Root-level `docker-compose.yml` runs the `web`, `db`, and `redis` services. Use `README.md` for architecture notes and `TESTING.md` for the current manual verification flow. There is no automated test directory or static asset tree yet; place future tests under `tests/` and name them `test_*.py`.

## Build, Test, and Development Commands

- `docker compose up -d --build` builds the Flask image and starts all services.
- `docker compose ps` confirms PostgreSQL and Redis health and shows container status.
- `docker compose logs web --tail 20` inspects recent API and cache activity.
- `curl.exe -I http://localhost:5000/<code>` verifies the 302 redirect path.
- `docker compose down` stops the stack while preserving the PostgreSQL named volume.

Follow `TESTING.md` for cache-miss and rate-limit checks. Its `FLUSHALL` command deletes all Redis data, so run it only against the disposable local Compose instance.

## Coding Style & Naming Conventions

Use four-space indentation and PEP 8 conventions for Python. Name functions and variables with `snake_case`, constants such as `ALPHABET` with `UPPER_SNAKE_CASE`, and routes with short descriptive handler names. Keep SQL parameterized through psycopg2 placeholders; never interpolate user input. Use two-space indentation in Compose YAML. No formatter or linter is configured, so keep imports grouped, comments concise, and changes consistent with `app/app.py`.

## Testing Guidelines

Manually test `POST /shorten`, cache-hit/cache-miss redirects, `404`, `429`, and `/health` before submitting changes. If adding automated tests, prefer `pytest`, isolate PostgreSQL and Redis state, and cover both cache and database fallback behavior. Document any new test command here and in `TESTING.md`.

## Commit & Pull Request Guidelines

Current history uses Conventional Commit-style subjects, for example `feat: build initial URL shortener with Redis and PostgreSQL`. Continue with concise prefixes such as `feat:`, `fix:`, `test:`, or `docs:`. Pull requests should explain behavior changes, list verification commands and results, link relevant issues, and include request/response examples when API behavior changes.

## Security & Configuration

Compose credentials are development defaults. Supply secrets through environment variables for non-local deployments, validate submitted URLs, and never commit credentials or generated database data.
