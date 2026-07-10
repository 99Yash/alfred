# Alfred Server App Guidance

## Composition Root

- `apps/server` is the executable composition and bootstrap layer. It wires package-owned services, starts workers and bridges, binds the HTTP server, and shuts resources down in dependency-safe order.
- Keep business rules, persistence, provider behavior, queue mechanics, and reusable workflow logic in their owning backend package/module. Do not grow `index.ts`, `runtime.ts`, or scripts into alternate domain implementations.
- Initialize resources at startup rather than module load, and preserve graceful shutdown for every resource started here.

## Built-Ins And Scripts

- Built-in workflows and agents are thin adapters: declare built-in identity/configuration, validate workflow input, and compose reusable domain operations from owning backend modules.
- Do not duplicate domain logic in built-ins to make it locally convenient. Move reusable behavior to the package/module that owns the domain, then adapt it here.
- Smoke, probe, repair, and backfill scripts are executable operational entrypoints. Reuse production boundaries, validate unknown input/output, make destructive intent explicit, and do not weaken types with fixture casts.
