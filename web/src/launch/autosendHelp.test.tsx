import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AutoSendHelp from "./AutoSendHelp";

afterEach(cleanup);

describe("AutoSendHelp", () => {
  it("is collapsed by default", () => {
    render(<AutoSendHelp />);
    const toggle = screen.getByRole("button", { name: /auto-send \(optional\)/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/press Send for you in the chat it opens/i)).toBeNull();
    expect(screen.queryByText(/legacy browser helper/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the built-in text, the three steps and the Steward note when expanded", () => {
    render(<AutoSendHelp />);
    fireEvent.click(screen.getByRole("button", { name: /auto-send \(optional\)/i }));
    expect(
      screen.getByText(/The launcher can press Send for you in the chat it opens, so a cell starts without a manual click\. Nothing is installed in the browser\./i),
    ).toBeTruthy();
    expect(screen.getByText(/Auto-send in the browser/i)).toBeTruthy();
    expect(screen.getByText(/Allow auto-send for this repo on this PC/i)).toBeTruthy();
    expect(screen.getByText(/3 second countdown with Cancel/i)).toBeTruthy();
    expect(screen.getByText(/does not send and you press Send yourself/i)).toBeTruthy();
    expect(screen.getByText(/Steward chats never auto-send/i)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("keeps the legacy block collapsed until opened", () => {
    render(<AutoSendHelp />);
    fireEvent.click(screen.getByRole("button", { name: /auto-send \(optional\)/i }));
    const legacy = screen.getByRole("button", { name: /legacy browser helper/i });
    expect(legacy.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/autoSendEngine/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(legacy);
    expect(legacy.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Only needed if you switched the launcher to the userscript engine/i)).toBeTruthy();
    expect(screen.getByText(/autoSendEngine/)).toBeTruthy();
  });

  it("links to blueprint-autosend.user.js in a new tab", () => {
    render(<AutoSendHelp />);
    fireEvent.click(screen.getByRole("button", { name: /auto-send \(optional\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /legacy browser helper/i }));
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.getAttribute("href")!.endsWith("blueprint-autosend.user.js")).toBe(true);
    expect(link.target).toBe("_blank");
  });
});
