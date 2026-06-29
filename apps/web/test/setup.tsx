// Component-test setup. Call `installDom()` at the top level of every
// `*.test.tsx`.
//
// This file is `.tsx` (not `.ts`) on purpose: the repo-wide `tsc --noEmit` only
// globs `apps/**/*.ts`, so naming it `.tsx` keeps this DOM-typed test helper out
// of the root (Bun-typed) typecheck while `apps/web/tsconfig.json` still checks
// it with the DOM lib.
//
// Bun runs every test file in one shared process, and a module's top-level code
// runs only once for that process — so registration must happen in per-file
// `beforeAll`/`afterAll` hooks, registered by each file's `installDom()` call.
// Registering on `beforeAll` and tearing down on `afterAll` keeps the Happy DOM
// globals (document, window, fetch, …) from leaking into the CLI/Bun test files
// that run later in the same process.
import { afterAll, afterEach, beforeAll } from "bun:test";
import { cleanup } from "@testing-library/react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function installDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
  });
  afterEach(() => {
    cleanup();
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}
