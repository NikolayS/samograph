import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { installDom } from "../test/setup.tsx";
import { useShortcuts } from "./useShortcuts.tsx";

installDom();

function Harness({ navigate = () => {}, onHelp = () => {} }: { navigate?: (path: string) => void; onHelp?: () => void }) {
  useShortcuts({ navigate, onHelp });
  return <input name="meetingUrl" />;
}

describe("useShortcuts", () => {
  it("focuses the existing meeting URL input on / and prevents typing", () => {
    const view = render(<Harness />);
    const event = new KeyboardEvent("keydown", { key: "/", cancelable: true, bubbles: true });
    document.dispatchEvent(event);
    expect(document.activeElement).toBe(view.container.querySelector('input[name="meetingUrl"]'));
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores shortcuts from editable controls", () => {
    const navigate = mock(() => {});
    const onHelp = mock(() => {});
    const view = render(<Harness navigate={navigate} onHelp={onHelp} />);
    const input = view.container.querySelector("input")!;
    input.focus();
    for (const key of ["/", "g", "d", "?"]) fireEvent.keyDown(input, { key });
    expect(navigate).toHaveBeenCalledTimes(0);
    expect(onHelp).toHaveBeenCalledTimes(0);
  });

  it("ignores all shortcuts while a modal dialog is open", () => {
    const navigate = mock(() => {});
    const onHelp = mock(() => {});
    const view = render(<Harness navigate={navigate} onHelp={onHelp} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const dialogButton = document.createElement("button");
    dialog.append(dialogButton);
    document.body.append(dialog);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "d" });
    const slash = new KeyboardEvent("keydown", { key: "/", cancelable: true, bubbles: true });
    dialogButton.dispatchEvent(slash);
    fireEvent.keyDown(document, { key: "?" });

    expect(navigate).toHaveBeenCalledTimes(0);
    expect(onHelp).toHaveBeenCalledTimes(0);
    expect(document.activeElement).not.toBe(view.container.querySelector('input[name="meetingUrl"]'));
    expect(slash.defaultPrevented).toBe(false);
    dialog.remove();
  });

  it("navigates for g d and g s, but not unrelated sequences", () => {
    const seen: string[] = [];
    render(<Harness navigate={(path) => seen.push(path)} />);
    fireEvent.keyDown(document, { key: "g" }); fireEvent.keyDown(document, { key: "d" });
    fireEvent.keyDown(document, { key: "g" }); fireEvent.keyDown(document, { key: "x" });
    fireEvent.keyDown(document, { key: "g" }); fireEvent.keyDown(document, { key: "s" });
    expect(seen).toEqual(["/dashboard", "/settings"]);
  });

  it("opens help with ? and ignores modifier combinations", () => {
    const navigate = mock(() => {});
    const onHelp = mock(() => {});
    render(<Harness navigate={navigate} onHelp={onHelp} />);
    fireEvent.keyDown(document, { key: "?", shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      fireEvent.keyDown(document, { key: "g", [modifier]: true });
      fireEvent.keyDown(document, { key: "d", [modifier]: true });
      fireEvent.keyDown(document, { key: "?", [modifier]: true });
    }
    expect(navigate).toHaveBeenCalledTimes(0);
    expect(onHelp).toHaveBeenCalledTimes(1);
  });
});
