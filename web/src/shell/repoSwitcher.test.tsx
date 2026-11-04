// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelContextValue } from "../core/store";
import RepoSwitcher from "./RepoSwitcher";

const h = vi.hoisted(() => ({ panel: {} as PanelContextValue }));
vi.mock("../core/store", () => ({ usePanel: () => h.panel }));

const switchRepo = vi.fn();
const forgetRepo = vi.fn();

beforeEach(() => {
  // Radix Popper measures with ResizeObserver, which jsdom lacks
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  switchRepo.mockReset().mockReturnValue(true);
  forgetRepo.mockReset();
  h.panel = { repo: "o/r", state: null, recentRepos: ["o/r", "a/b"], switchRepo, forgetRepo } as unknown as PanelContextValue;
});
afterEach(cleanup);

const openIt = () => fireEvent.click(screen.getByRole("button", { name: /o\/r · main/ }));

describe("RepoSwitcher", () => {
  it("shows the chip as a popover button and opens a list of recents", () => {
    render(<RepoSwitcher />);
    const trigger = screen.getByRole("button", { name: /o\/r · main/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    openIt();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("a/b")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Current repository" })).toHaveLength(1);
  });

  it("Enter in the input switches and closes", () => {
    render(<RepoSwitcher />);
    openIt();
    const input = screen.getByRole("textbox", { name: /owner\/name/ });
    fireEvent.change(input, { target: { value: "acme/panel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(switchRepo).toHaveBeenCalledWith("acme/panel");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking a recent repo switches to it", () => {
    render(<RepoSwitcher />);
    openIt();
    fireEvent.click(screen.getByRole("button", { name: "a/b" }));
    expect(switchRepo).toHaveBeenCalledWith("a/b");
  });

  it("invalid input shows an error and keeps the popover open", () => {
    switchRepo.mockReturnValue(false);
    render(<RepoSwitcher />);
    openIt();
    const input = screen.getByRole("textbox", { name: /owner\/name/ });
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("alert").textContent).toMatch(/owner\/name/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the remove button forgets a recent repo", () => {
    render(<RepoSwitcher />);
    openIt();
    fireEvent.click(screen.getByRole("button", { name: "Remove a/b from recent" }));
    expect(forgetRepo).toHaveBeenCalledWith("a/b");
  });

  it("Escape closes the popover", () => {
    render(<RepoSwitcher />);
    openIt();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
