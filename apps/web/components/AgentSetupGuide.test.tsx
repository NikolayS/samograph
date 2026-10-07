import { it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { installDom } from "../test/setup.tsx";
import { AgentSetupGuide } from "./AgentSetupGuide.tsx";
installDom();
it("gives an unreleased CLI install and an explicit same-session workflow without credentials", () => {
  const view = render(<AgentSetupGuide />);
  expect(view.getByRole("heading", {name:"Set up your agent"})).toBeDefined();
  expect(view.container.textContent).toContain("6eee80e2610003a9c9435075100817e33a32947a");
  expect(view.container.textContent).toContain("bun install --frozen-lockfile");
  expect(view.container.textContent).toContain("agent --help");
  expect(view.container.textContent).toContain("/statusline");
  expect(view.container.textContent).toContain("--credential-file PRIVATE_FILE");
  expect(view.container.textContent).toContain("pbpaste |");
  expect(view.container.textContent).toContain("crypto.randomUUID()");
  expect(view.container.textContent).toContain("--request-id REQUEST_UUID");
  expect(view.container.textContent).toContain("does not revoke");
  expect(view.container.textContent).toContain("cannot find the exact ID");
});
