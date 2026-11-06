import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AutoSendHelp from "./AutoSendHelp";

afterEach(cleanup);

describe("AutoSendHelp", () => {
  it("is collapsed by default", () => {
    render(<AutoSendHelp />);
    const toggle = screen.getByRole("button", { name: /auto-send helper \(optional\)/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/userscript manager/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the three steps and notes when expanded", () => {
    render(<AutoSendHelp />);
    fireEvent.click(screen.getByRole("button", { name: /auto-send helper/i }));
    expect(screen.getByText(/Install a userscript manager/i)).toBeTruthy();
    expect(screen.getByText(/Install the script with the link/i)).toBeTruthy();
    expect(screen.getByText(/set the allowed repos/i)).toBeTruthy();
    expect(screen.getByText(/Steward chats never auto-send/i)).toBeTruthy();
    expect(screen.getByText(/Auto-send in the browser/i)).toBeTruthy();
  });

  it("links to blueprint-autosend.user.js in a new tab", () => {
    render(<AutoSendHelp />);
    fireEvent.click(screen.getByRole("button", { name: /auto-send helper/i }));
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.getAttribute("href")!.endsWith("blueprint-autosend.user.js")).toBe(true);
    expect(link.target).toBe("_blank");
  });
});
