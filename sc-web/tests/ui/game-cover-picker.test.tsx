// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import GameCoverPicker from "@/components/GameCoverPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  root = undefined;
  container = undefined;
});

function renderPicker(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(GameCoverPicker, {
    open: true,
    game: { id: "game-a", serverId: "server-a", name: "Super Mario World", platform: "SNES", coverUrl: "/current.png" },
    serverName: "Joel's Arcade",
    onClose: vi.fn(),
    onSaved: vi.fn(),
  })));
  return container;
}

describe("GameCoverPicker", () => {
  it("loads state and provider candidates only after the picker opens", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ override: null, capabilities: { configured: true, canManage: true }, defaultCoverUrl: "/default.png" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ id: "signed", type: "boxart", title: "Super Mario World (USA)", previewUrl: "/preview.png", attribution: "RetroArch thumbnail database" }] }), { status: 200 }));
    renderPicker(fetchMock);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Choose artwork everyone on this server will see");
    expect(document.body.textContent).toContain("Super Mario World (USA)");
    expect(document.body.textContent).toContain("Upload my own");
  });

  it("keeps upload unavailable when durable storage is not configured", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ override: null, capabilities: { configured: false, canManage: true }, defaultCoverUrl: "/default.png" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    renderPicker(fetchMock);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const uploadTab = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Upload my own")) as HTMLButtonElement;
    expect(uploadTab.disabled).toBe(true);
    expect(document.body.textContent).toContain("Cover storage is not configured");
    const candidate = document.querySelector('input[type="radio"]') as HTMLInputElement | null;
    expect(candidate).toBeNull();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Save cover")) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("offers a retry that reloads settings and candidates after an initial failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ override: null, capabilities: { configured: true, canManage: true }, defaultCoverUrl: "/default.png" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ id: "signed", type: "boxart", title: "Retry result", previewUrl: "/preview.png", attribution: "RetroArch thumbnail database" }] }), { status: 200 }));
    renderPicker(fetchMock);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Retry") as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).toContain("Retry result");
  });

  it("keeps the settings retry visible after a successful candidate search", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ id: "signed", type: "boxart", title: "Search result", previewUrl: "/preview.png", attribution: "RetroArch thumbnail database" }] }), { status: 200 }));
    renderPicker(fetchMock);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const search = [...document.querySelectorAll("button")].find((button) => button.textContent === "Search") as HTMLButtonElement;
    await act(async () => { search.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(document.body.textContent).toContain("Could not load cover settings");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
    expect(document.body.textContent).toContain("Search result");
  });

  it("models selectable artwork as a keyboard-native radio group", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ override: null, capabilities: { configured: true, canManage: true }, defaultCoverUrl: "/default.png" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ id: "signed", type: "boxart", title: "Accessible art", previewUrl: "/preview.png", attribution: "RetroArch thumbnail database" }] }), { status: 200 }));
    renderPicker(fetchMock);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="radiogroup"]')).toBeTruthy();
    const radio = document.querySelector('input[type="radio"]') as HTMLInputElement;
    expect(radio.getAttribute("aria-label")).toContain("Accessible art");
    await act(async () => radio.click());
    expect(radio.checked).toBe(true);
  });
});
