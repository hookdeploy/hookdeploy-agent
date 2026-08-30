import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

type Phase = "disconnected" | "connecting" | "connected" | "reconnecting" | "revoked";
type Page = "dashboard" | "endpoints" | "taps" | "settings";

interface ConnectStatus {
  phase: Phase;
  region: string | null;
  relay: string | null;
  detail: string | null;
}

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  active: boolean;
}

interface DestinationInfo {
  id: string;
  name: string;
  kind: string;
}

interface EndpointInfo {
  id: string;
  name: string;
  slug?: string | null;
  url?: string | null;
  destinations: DestinationInfo[];
}

interface Catalog {
  endpoints: EndpointInfo[];
  taps: TapInfo[];
}

interface TapInfo {
  id: string;
  endpoint: string;
  destination: string;
  target: string;
  expires: string | null;
}

interface PortInfo {
  port: number;
  address: string;
  process: string;
  pid: number;
}

interface Snapshot {
  status: ConnectStatus;
  agent_id: string | null;
  agent_name: string | null;
  org_name: string | null;
  enroll_url: string | null;
  enroll_phase: { kind: string; url?: string; org?: string; message?: string };
}

interface TapHandle {
  id: string;
  endpoint_id: string;
  destination_id: string | null;
  port: number;
  path: string;
  target: string;
}

interface SavedTap {
  id: string;
  endpointId: string;
  endpointName: string;
  destId: string | null;
  destName: string;
  port: number;
  path: string;
}

const NAME_KEY = "hookdeploy.agentName";
const SAVED_KEY = "hookdeploy.savedTaps";
const EP_PAGE_SIZE = 10;
const PAGES: Record<Page, { title: string; desc: string }> = {
  dashboard: { title: "Dashboard", desc: "Overview of this agent" },
  endpoints: { title: "Endpoints", desc: "Endpoints in this organization" },
  taps: { title: "Taps", desc: "Live taps and saved shortcuts" },
  settings: { title: "Settings", desc: "This agent and enrollment" },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TAP_ICON =
  '<svg width="14" height="14" viewBox="1 3.5 22 18.5" fill="none" aria-hidden="true"><rect x="2" y="5" width="20" height="7" rx="3.5" stroke="currentColor" stroke-width="2"/><path d="M12 12v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 20h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>';
const CHECK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let orgs: OrgInfo[] = [];
let catalog: Catalog = { endpoints: [], taps: [] };
let ports: PortInfo[] = [];
let hostname: string | null = null;
let page: Page = "dashboard";
let endpointsPage = 1;
let selectedDest: { endpointId: string; destId: string | null } | null = null;
let pendingEndTaps: { tapIds: string[]; endpointName: string } | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showError(msg: string | null) {
  for (const id of ["error", "gate-error"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !msg);
    el.textContent = msg ?? "";
  }
}

function invokeError(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object") {
    const rec = e as { message?: unknown; error?: unknown };
    if (typeof rec.message === "string" && rec.message.trim()) return rec.message;
    if (typeof rec.error === "string" && rec.error.trim()) return rec.error;
    try {
      const json = JSON.stringify(e);
      if (json && json !== "{}") return json;
    } catch {
      /* ignore */
    }
  }
  return e == null ? "Something went wrong." : String(e);
}

function agentDisplayName(): string {
  const custom = localStorage.getItem(NAME_KEY)?.trim();
  return custom || hostname || "This agent";
}

function applyAgentName() {
  $("agent-name").textContent = agentDisplayName();
  const gateHost = document.getElementById("gate-host");
  if (gateHost) gateHost.textContent = hostname || "This machine";
  const settingsHost = document.getElementById("settings-hostname");
  if (settingsHost) settingsHost.textContent = hostname || "—";
  const input = $("settings-name") as HTMLInputElement;
  if (document.activeElement !== input) {
    input.value = localStorage.getItem(NAME_KEY) || hostname || "";
    input.placeholder = hostname || "Agent name";
  }
}

function relayInstanceId(relay: string): string {
  const host = relay.split("/")[0].split(":")[0];
  const name = host.split(".")[0] ?? host;
  return name.replace(/^relay-/i, "") || relay;
}

function applyStatus(s: ConnectStatus) {
  $("status-dot").className = `dot ${s.phase}`;
  $("status-phase").textContent = s.phase[0].toUpperCase() + s.phase.slice(1);
  const relay = $("status-relay");
  if (s.relay) {
    relay.textContent = `Connected to ${relayInstanceId(s.relay)}`;
    relay.classList.remove("hidden");
    relay.title = s.relay;
  } else {
    relay.textContent = "";
    relay.removeAttribute("title");
    relay.classList.add("hidden");
  }
  applyAgentName();
}

function activeOrgId(): string {
  return orgs.find((o) => o.active)?.id ?? "default";
}

function loadSaved(): SavedTap[] {
  try {
    const all = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}") as Record<string, SavedTap[]>;
    return all[activeOrgId()] ?? [];
  } catch {
    return [];
  }
}

function persistSaved(rows: SavedTap[]) {
  const all = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}") as Record<string, SavedTap[]>;
  all[activeOrgId()] = rows;
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
}

function upsertSaved(tap: SavedTap) {
  const rows = loadSaved().filter((s) => s.id !== tap.id);
  rows.unshift(tap);
  persistSaved(rows);
}

function savedId(endpointId: string, destId: string | null, port: number, path: string): string {
  return `${endpointId}:${destId ?? "endpoint"}:${port}:${path}`;
}

function forwardsHere(ep: EndpointInfo): boolean {
  return ep.destinations.some((d) => d.kind === "agent");
}

function tapsForEndpoint(ep: EndpointInfo): TapInfo[] {
  return catalog.taps.filter((t) => t.endpoint === ep.name || t.endpoint === ep.id);
}

function tapCountFor(ep: EndpointInfo): number {
  return tapsForEndpoint(ep).length;
}

function liveForSaved(saved: SavedTap): TapInfo | undefined {
  const target = `127.0.0.1:${saved.port}${saved.path}`;
  return catalog.taps.find(
    (t) =>
      t.target === target &&
      (t.endpoint === saved.endpointName || t.endpoint === saved.endpointId),
  );
}

function tapPill(count: number): string {
  if (count <= 0) return `<span class="muted">—</span>`;
  return `<span class="tap-pill" title="${count} active tap${count === 1 ? "" : "s"}"><span class="tap-pill-icon">${TAP_ICON}</span><span class="tap-pill-count">${count}</span></span>`;
}

function emptyTray(message: string): string {
  return `<div class="table-empty">${escapeHtml(message)}</div>`;
}

function tableWrap(head: string, body: string): string {
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function copyIdButton(id: string, label: string): string {
  return `<button type="button" class="copy-id" data-copy-id="${escapeHtml(id)}" title="${escapeHtml(id)}" aria-label="Copy ${escapeHtml(label.toLowerCase())}">ID ${COPY_ICON}</button>`;
}

function endpointPublicUrl(ep: Pick<EndpointInfo, "url" | "slug">): string {
  const direct = ep.url?.trim();
  if (direct) return direct;
  const slug = ep.slug?.trim();
  if (slug) return `https://hookdeploy.dev/a/${slug}`;
  return "";
}

function endpointNameCell(name: string, id: string, url?: string | null): string {
  const urlRow = url
    ? `<div class="cell-url">
        <span class="cell-url-text mono" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        <button type="button" class="copy-url" data-copy-url="${escapeHtml(url)}" title="Copy URL" aria-label="Copy endpoint URL">${COPY_ICON}</button>
      </div>`
    : "";
  return `<div class="cell-endpoint"><div class="cell-title-row"><div class="cell-title">${escapeHtml(name)}</div>${copyIdButton(id, "Endpoint ID")}</div>${urlRow}</div>`;
}

function isEnrolled(): boolean {
  return orgs.length > 0;
}

function setAuthed(enrolled: boolean) {
  const wasGated = !$("gate").classList.contains("hidden");
  $("gate").classList.toggle("hidden", enrolled);
  $("app").classList.toggle("hidden", !enrolled);
  if (enrolled && wasGated) {
    showPage("dashboard");
  }
  if (!enrolled) {
    setEnrollCopy(
      "This machine is not enrolled in an organization. Login opens the browser so you can attach it.",
    );
    document.querySelectorAll(".enroll-url-wrap, .enroll-code-wrap").forEach((el) => {
      el.classList.add("hidden");
    });
    setEnrollButtonsDisabled(false);
  }
}

function showPage(next: Page) {
  if (!isEnrolled()) return;
  page = next;
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === next);
  });
  (["dashboard", "endpoints", "taps", "settings"] as Page[]).forEach((id) => {
    $(`page-${id}`).classList.toggle("hidden", id !== next);
  });
  $("page-title").textContent = PAGES[next].title;
  $("page-desc").textContent = PAGES[next].desc;
  $("ep-search").classList.toggle("hidden", next !== "endpoints");
  if (next === "taps" && ports.length === 0 && "__TAURI_INTERNALS__" in window) {
    void refreshPorts().catch((e) => showError(String(e)));
  }
}

function renderOrgs() {
  const active = orgs.find((o) => o.active);
  $("org-name").textContent = active?.name ?? "No organization";
  const settingsOrgName = document.getElementById("settings-org-name");
  const settingsOrgId = document.getElementById("settings-org-id");
  if (settingsOrgName) settingsOrgName.textContent = active?.name ?? "No organization";
  if (settingsOrgId) settingsOrgId.textContent = active?.id ?? "";
  const menu = $("org-menu");
  const rows = orgs
    .map((o) => {
      const check = o.active
        ? `<svg class="check" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : "";
      return `<button type="button" data-id="${o.id}" role="menuitem"><span><span>${escapeHtml(o.name)}</span><span class="org-id mono">${escapeHtml(o.id)}</span></span>${check}</button>`;
    })
    .join("");
  menu.innerHTML = `<div class="org-menu-label">Your organizations</div>${rows}<div class="org-menu-sep"></div><button type="button" data-add="1" role="menuitem">Add organization</button>`;
  menu.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.getAttribute("data-add")) {
        menu.classList.add("hidden");
        void startLogin();
        return;
      }
      try {
        orgs = await invoke<OrgInfo[]>("switch_org", { id: btn.getAttribute("data-id") });
        menu.classList.add("hidden");
        endpointsPage = 1;
        renderOrgs();
        await refreshCatalog();
      } catch (e) {
        showError(String(e));
      }
    });
  });
}

function renderDashboard() {
  const inbound = catalog.endpoints.filter(forwardsHere);
  $("dash-ep-count").textContent = String(catalog.endpoints.length);
  $("dash-fwd-count").textContent = String(inbound.length);
  $("dash-tap-count").textContent = String(catalog.taps.length);

  $("dash-inbound").innerHTML = inbound.length
    ? tableWrap(
        `<th>Endpoint</th><th>Destination</th><th>Taps</th>`,
        inbound
          .map((ep) => {
            const dests = ep.destinations
              .filter((d) => d.kind === "agent")
              .map((d) => escapeHtml(d.name))
              .join(", ");
            return `<tr><td><div class="cell-title">${escapeHtml(ep.name)}</div><div class="cell-sub mono">${escapeHtml(ep.id)}</div></td><td>${dests || "—"}</td><td>${tapPill(tapCountFor(ep))}</td></tr>`;
          })
          .join(""),
      )
    : emptyTray("No endpoints currently forward to this agent.");

  $("dash-taps").innerHTML = liveTapsTable();
}

function endpointSearchQuery(): string {
  return ($("ep-search") as HTMLInputElement).value.trim().toLowerCase();
}

function filteredEndpoints(): EndpointInfo[] {
  const q = endpointSearchQuery();
  if (!q) return catalog.endpoints;
  return catalog.endpoints.filter((ep) => ep.name.toLowerCase().includes(q));
}

function renderEndpointsPage() {
  const pager = $("ep-pager");
  const matches = filteredEndpoints();
  const total = matches.length;
  const searching = endpointSearchQuery().length > 0;
  if (!catalog.endpoints.length) {
    endpointsPage = 1;
    $("ep-table").innerHTML = emptyTray("No endpoints in this organization.");
    pager.classList.add("hidden");
    pager.innerHTML = "";
    return;
  }
  if (!total) {
    endpointsPage = 1;
    $("ep-table").innerHTML = emptyTray("No endpoints match that name.");
    pager.classList.add("hidden");
    pager.innerHTML = "";
    return;
  }
  const pageCount = Math.max(1, Math.ceil(total / EP_PAGE_SIZE));
  if (endpointsPage > pageCount) endpointsPage = pageCount;
  if (endpointsPage < 1) endpointsPage = 1;
  const start = (endpointsPage - 1) * EP_PAGE_SIZE;
  const rows = matches.slice(start, start + EP_PAGE_SIZE);
  $("ep-table").innerHTML = tableWrap(
    `<th>Endpoint</th><th>This agent</th><th>Tap</th>`,
    rows
      .map((ep) => {
        const here = forwardsHere(ep);
        const live = tapsForEndpoint(ep);
        const tapBtn = live.length
          ? `<button type="button" class="tap-action tap-active" data-end-tap="${escapeHtml(ep.id)}">${TAP_ICON} Tap Active</button>`
          : `<button type="button" class="tap-action" data-create-tap="${escapeHtml(ep.id)}">${TAP_ICON} Tap</button>`;
        return `<tr>
          <td>${endpointNameCell(ep.name, ep.id, endpointPublicUrl(ep))}</td>
          <td>${here ? `<span class="fwd-badge">Forwards here</span>` : `<span class="muted">—</span>`}</td>
          <td>${tapBtn}</td>
        </tr>`;
      })
      .join(""),
  );
  if (pageCount <= 1) {
    pager.classList.add("hidden");
    pager.innerHTML = "";
    return;
  }
  const from = start + 1;
  const to = start + rows.length;
  pager.classList.remove("hidden");
  pager.innerHTML = `<span>Showing ${from}–${to} of ${total}${searching ? " match" + (total === 1 ? "" : "es") : ""}</span>
    <div class="table-pager-nav">
      <button type="button" class="ghost" data-ep-page="prev"${endpointsPage <= 1 ? " disabled" : ""}>Previous</button>
      <span>Page ${endpointsPage} of ${pageCount}</span>
      <button type="button" class="ghost" data-ep-page="next"${endpointsPage >= pageCount ? " disabled" : ""}>Next</button>
    </div>`;
}

function setConfirmOpen(open: boolean, message?: string) {
  $("confirm-dialog").classList.toggle("hidden", !open);
  if (message) $("confirm-message").textContent = message;
  ($("confirm-ok") as HTMLButtonElement).disabled = false;
  ($("confirm-ok") as HTMLButtonElement).textContent = "End tap";
}

function askEndTap(ep: EndpointInfo) {
  const live = tapsForEndpoint(ep);
  if (!live.length) return;
  pendingEndTaps = { tapIds: live.map((t) => t.id), endpointName: ep.name };
  const message =
    live.length === 1
      ? `End the active tap on ${ep.name}?`
      : `End the ${live.length} active taps on ${ep.name}?`;
  setConfirmOpen(true, message);
}

async function confirmEndTap() {
  if (!pendingEndTaps) return;
  const { tapIds } = pendingEndTaps;
  const ok = $("confirm-ok") as HTMLButtonElement;
  ok.disabled = true;
  ok.textContent = "Ending…";
  try {
    for (const tapId of tapIds) {
      await invoke("stop_tap", { tapId });
    }
    pendingEndTaps = null;
    setConfirmOpen(false);
    showError(null);
    await refreshCatalog();
  } catch (e) {
    ok.disabled = false;
    ok.textContent = "End tap";
    showError(invokeError(e));
  }
}

function liveTapsTable(): string {
  if (!catalog.taps.length) {
    return emptyTray("No live taps. A tap stays listed until it expires or is stopped.");
  }
  return tableWrap(
    `<th>Endpoint</th><th>Destination</th><th>Target</th><th>Expires</th><th></th>`,
    catalog.taps
      .map(
        (t) => `<tr>
          <td class="cell-title">${escapeHtml(t.endpoint)}</td>
          <td>${escapeHtml(t.destination || "(endpoint)")}</td>
          <td class="mono">${escapeHtml(t.target)}</td>
          <td class="cell-sub">${escapeHtml(t.expires ?? "—")}</td>
          <td><button class="stop" type="button" data-stop="${escapeHtml(t.id)}">Stop</button></td>
        </tr>`,
      )
      .join(""),
  );
}

function renderTapsPage() {
  $("taps-live").innerHTML = liveTapsTable();
  const saved = loadSaved();
  $("taps-saved").innerHTML = saved.length
    ? tableWrap(
        `<th>Endpoint</th><th>Destination</th><th>Target</th><th>Status</th><th></th>`,
        saved
          .map((s) => {
            const live = liveForSaved(s);
            const target = `127.0.0.1:${s.port}${s.path}`;
            const action = live
              ? `<button class="stop" type="button" data-stop="${escapeHtml(live.id)}">Stop</button>`
              : `<button type="button" data-enable="${escapeHtml(s.id)}">Re-enable</button>`;
            return `<tr>
              <td class="cell-title">${escapeHtml(s.endpointName)}</td>
              <td>${escapeHtml(s.destName)}</td>
              <td class="mono">${escapeHtml(target)}</td>
              <td>${live ? `<span class="fwd-badge">Active</span>` : `<span class="muted">Saved</span>`}</td>
              <td class="row-between">${action}<button class="ghost" type="button" data-forget="${escapeHtml(s.id)}">Remove</button></td>
            </tr>`;
          })
          .join(""),
      )
    : emptyTray("No saved taps yet. Create a tap to keep its port and path as a shortcut.");

  document.querySelectorAll<HTMLButtonElement>("[data-enable]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const savedTap = loadSaved().find((s) => s.id === btn.dataset.enable);
      if (!savedTap) return;
      try {
        await invoke<TapHandle>("create_tap", {
          endpointId: savedTap.endpointId,
          destinationId: savedTap.destId,
          port: savedTap.port,
          path: savedTap.path,
          noTty: true,
        });
        await refreshCatalog();
      } catch (e) {
        showError(String(e));
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-forget]").forEach((btn) => {
    btn.addEventListener("click", () => {
      persistSaved(loadSaved().filter((s) => s.id !== btn.dataset.forget));
      renderAll();
    });
  });
}

function bindLiveTapActions() {
  document.querySelectorAll<HTMLButtonElement>("[data-stop]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await invoke("stop_tap", { tapId: btn.dataset.stop });
        showError(null);
        await refreshCatalog();
      } catch (e) {
        btn.disabled = false;
        showError(invokeError(e));
      }
    });
  });
}

function renderAll() {
  renderDashboard();
  renderEndpointsPage();
  renderTapsPage();
  bindLiveTapActions();
}

type SelectOption = { value: string; label: string };

const SELECT_CHECK =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const hdSelects: HdSelect[] = [];

class HdSelect {
  readonly root: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly valueEl: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly placeholder: string;
  private options: SelectOption[] = [];
  private current = "";
  private disabled = false;
  onChange: ((value: string) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.trigger = root.querySelector(".hd-select-trigger") as HTMLButtonElement;
    this.valueEl = root.querySelector(".hd-select-value") as HTMLElement;
    this.menu = root.querySelector(".hd-select-menu") as HTMLElement;
    this.placeholder = root.dataset.placeholder || "Select…";
    this.trigger.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.disabled) return;
      if (this.root.classList.contains("open")) this.close();
      else this.open();
    });
    this.trigger.addEventListener("keydown", (ev) => this.onTriggerKey(ev));
    this.menu.addEventListener("keydown", (ev) => this.onMenuKey(ev));
  }

  get value(): string {
    return this.current;
  }

  setDisabled(next: boolean) {
    this.disabled = next;
    this.trigger.disabled = next;
    if (next) this.close();
  }

  setOptions(options: SelectOption[], preferred?: string) {
    this.options = options;
    const match = preferred !== undefined && options.some((o) => o.value === preferred);
    this.current = match ? (preferred as string) : (options[0]?.value ?? "");
    this.renderMenu();
    this.syncLabel();
  }

  close() {
    this.root.classList.remove("open");
    this.menu.classList.add("hidden");
    this.trigger.setAttribute("aria-expanded", "false");
    this.menu.style.top = "";
    this.menu.style.bottom = "";
    this.menu.style.left = "";
    this.menu.style.width = "";
    this.menu.style.position = "";
  }

  private open() {
    hdSelects.forEach((s) => {
      if (s !== this) s.close();
    });
    this.root.classList.add("open");
    this.menu.classList.remove("hidden");
    this.trigger.setAttribute("aria-expanded", "true");
    this.placeMenu();
    const selected = this.menu.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    (selected ?? this.menu.querySelector<HTMLButtonElement>(".hd-select-item"))?.focus();
  }

  private placeMenu() {
    const rect = this.trigger.getBoundingClientRect();
    const menuHeight = Math.min(240, this.menu.scrollHeight || 240);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    this.menu.style.position = "fixed";
    this.menu.style.left = `${rect.left}px`;
    this.menu.style.width = `${rect.width}px`;
    if (spaceBelow < menuHeight && rect.top > spaceBelow) {
      this.menu.style.top = "auto";
      this.menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      this.menu.style.bottom = "auto";
      this.menu.style.top = `${rect.bottom + 4}px`;
    }
  }

  private syncLabel() {
    const opt = this.options.find((o) => o.value === this.current);
    if (opt) {
      this.valueEl.textContent = opt.label;
      this.valueEl.classList.toggle("is-placeholder", !opt.label);
    } else {
      this.valueEl.textContent = this.placeholder;
      this.valueEl.classList.add("is-placeholder");
    }
  }

  private renderMenu() {
    this.menu.innerHTML = this.options
      .map(
        (o) => `<button type="button" class="hd-select-item" role="option" data-value="${escapeHtml(o.value)}" aria-selected="${o.value === this.current ? "true" : "false"}">
          <span class="hd-select-item-label">${escapeHtml(o.label)}</span>
          <span class="hd-select-check">${SELECT_CHECK}</span>
        </button>`,
      )
      .join("");
    this.menu.querySelectorAll<HTMLButtonElement>(".hd-select-item").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.choose(btn.dataset.value ?? "");
      });
    });
  }

  private choose(value: string) {
    const changed = value !== this.current;
    this.current = value;
    this.syncLabel();
    this.renderMenu();
    this.close();
    if (changed) this.onChange?.(value);
  }

  private items(): HTMLButtonElement[] {
    return [...this.menu.querySelectorAll<HTMLButtonElement>(".hd-select-item")];
  }

  private onTriggerKey(ev: KeyboardEvent) {
    if (this.disabled) return;
    if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      this.open();
    }
  }

  private onMenuKey(ev: KeyboardEvent) {
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.close();
      this.trigger.focus();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      const btn = items[i];
      if (btn) this.choose(btn.dataset.value ?? "");
    }
  }
}

function closeHdSelects() {
  hdSelects.forEach((s) => s.close());
}

let endpointSelect: HdSelect;
let destSelect: HdSelect;

function fillEndpointSelect(preferredId?: string) {
  const opts = catalog.endpoints.map((ep) => ({ value: ep.id, label: ep.name }));
  if (!opts.length) {
    endpointSelect.setOptions([{ value: "", label: "No endpoints in this organization" }], "");
    endpointSelect.setDisabled(true);
  } else {
    endpointSelect.setDisabled(false);
    endpointSelect.setOptions(opts, preferredId || endpointSelect.value);
  }
  fillDestinations();
}

function fillDestinations() {
  const endpointId = endpointSelect.value;
  const ep = catalog.endpoints.find((e) => e.id === endpointId);
  if (!ep) {
    destSelect.setOptions([{ value: "", label: "No endpoints in this organization" }], "");
    destSelect.setDisabled(true);
    selectedDest = null;
    updateTapTarget();
    return;
  }
  destSelect.setDisabled(false);
  destSelect.setOptions(
    [
      { value: "", label: "Raw incoming webhook" },
      ...ep.destinations.map((d) => ({
        value: d.id,
        label: `${d.name} (${d.kind})`,
      })),
    ],
    "",
  );
  selectedDest = { endpointId: ep.id, destId: null };
  updateTapTarget();
}

function applyDestSelection() {
  const endpointId = endpointSelect.value;
  const destId = destSelect.value || null;
  const ep = catalog.endpoints.find((e) => e.id === endpointId);
  selectedDest = ep ? { endpointId: ep.id, destId } : null;
  updateTapTarget();
}

function portFilterQuery(): string {
  const input = document.getElementById("port-filter") as HTMLInputElement | null;
  return input?.value.trim().toLowerCase() ?? "";
}

function visiblePorts(): PortInfo[] {
  const q = portFilterQuery();
  if (!q) return ports;
  return ports.filter(
    (p) =>
      String(p.port).includes(q) ||
      p.process.toLowerCase().includes(q) ||
      p.address.toLowerCase().includes(q),
  );
}

function renderPorts() {
  const shown = visiblePorts();
  const empty = !ports.length
    ? "No loopback TCP listeners."
    : "No listeners match this filter.";
  $("ports").innerHTML = shown.length
    ? shown
        .map(
          (p) =>
            `<li data-port="${p.port}"><span class="mono">${p.port}</span> ${escapeHtml(p.process)} <span class="muted">${escapeHtml(p.address)}</span></li>`,
        )
        .join("")
    : `<li class="muted">${empty}</li>`;
  $("ports").querySelectorAll("li[data-port]").forEach((li) => {
    li.addEventListener("click", () => {
      $("ports").querySelectorAll("li").forEach((x) => x.classList.remove("active"));
      li.classList.add("active");
      ($("tap-port") as HTMLInputElement).value = li.getAttribute("data-port") ?? "";
      updateTapTarget();
    });
  });
}

function updateTapTarget() {
  const port = Number(($("tap-port") as HTMLInputElement).value);
  const path = ($("tap-path") as HTMLInputElement).value || "/";
  const ready = !!(selectedDest && port > 0);
  ($("start-tap") as HTMLButtonElement).disabled = !ready;
  $("tap-target").textContent = selectedDest
    ? `${selectedDest.endpointId} → 127.0.0.1:${port || "?"}${path}`
    : "Select an endpoint and destination, then a port.";
}

function setDialogOpen(open: boolean, endpointId?: string) {
  closeHdSelects();
  $("tap-dialog").classList.toggle("hidden", !open);
  if (open) {
    fillEndpointSelect(endpointId);
    void refreshPorts().catch((e) => showError(String(e)));
  }
}

async function refreshCatalog() {
  catalog = await invoke<Catalog>("list_endpoints");
  renderAll();
}

async function refreshPorts() {
  ports = await invoke<PortInfo[]>("list_ports");
  renderPorts();
}

function setEnrollButtonsDisabled(disabled: boolean) {
  document.querySelectorAll<HTMLButtonElement>(".enroll-start, #settings-add-org").forEach((btn) => {
    btn.disabled = disabled;
  });
}

function setEnrollCopy(text: string) {
  document.querySelectorAll(".enroll-copy").forEach((el) => {
    el.textContent = text;
  });
}

function enrollCodeValue(): string {
  for (const input of document.querySelectorAll<HTMLInputElement>(".enroll-code-input")) {
    if (input.value.trim()) return input.value;
  }
  return "";
}

async function refreshOrgs() {
  try {
    orgs = await invoke<OrgInfo[]>("list_orgs");
    renderOrgs();
    setAuthed(orgs.length > 0);
    return orgs.length > 0;
  } catch {
    orgs = [];
    renderOrgs();
    setAuthed(false);
    return false;
  }
}

let unenrolling = false;
let enrollConnectStarted = false;

async function unenrollCurrentOrg() {
  if (unenrolling) return;
  unenrolling = true;
  const btn = document.getElementById("settings-unenroll") as HTMLButtonElement | null;
  const status = document.getElementById("settings-status");
  const label = btn?.textContent ?? "Unenroll current org";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Unenrolling…";
  }
  if (status) status.textContent = "Removing this organization…";
  showError(null);
  try {
    const remaining = await invoke<OrgInfo[]>("unenroll");
    orgs = remaining;
    catalog = { endpoints: [], taps: [] };
    endpointsPage = 1;
    renderOrgs();
    if (remaining.length === 0) {
      orgs = [];
      enrollConnectStarted = false;
      setAuthed(false);
      if (status) status.textContent = "";
    } else {
      setAuthed(true);
      if (status) status.textContent = `Unenrolled. ${remaining.length} organization${remaining.length === 1 ? "" : "s"} left.`;
      try {
        await refreshCatalog();
      } catch (e) {
        showError(invokeError(e));
      }
    }
    renderAll();
  } catch (e) {
    const msg = invokeError(e);
    showError(msg);
    if (status) status.textContent = msg;
  } finally {
    unenrolling = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

document.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target?.closest("#settings-unenroll")) {
    ev.preventDefault();
    void unenrollCurrentOrg();
    return;
  }
  const tapBtn = target?.closest<HTMLButtonElement>("[data-create-tap]");
  if (tapBtn?.dataset.createTap) {
    ev.preventDefault();
    setDialogOpen(true, tapBtn.dataset.createTap);
    return;
  }
  const endTapBtn = target?.closest<HTMLButtonElement>("[data-end-tap]");
  if (endTapBtn?.dataset.endTap) {
    ev.preventDefault();
    const ep = catalog.endpoints.find((e) => e.id === endTapBtn.dataset.endTap);
    if (ep) askEndTap(ep);
    return;
  }
  const pageBtn = target?.closest<HTMLButtonElement>("[data-ep-page]");
  if (pageBtn?.dataset.epPage && !pageBtn.disabled) {
    ev.preventDefault();
    const pageCount = Math.max(1, Math.ceil(filteredEndpoints().length / EP_PAGE_SIZE));
    if (pageBtn.dataset.epPage === "prev") endpointsPage = Math.max(1, endpointsPage - 1);
    else endpointsPage = Math.min(pageCount, endpointsPage + 1);
    renderEndpointsPage();
    return;
  }
  const copyUrlBtn = target?.closest<HTMLButtonElement>("[data-copy-url]");
  if (copyUrlBtn?.dataset.copyUrl) {
    ev.preventDefault();
    ev.stopPropagation();
    const url = copyUrlBtn.dataset.copyUrl;
    void navigator.clipboard.writeText(url).then(
      () => {
        copyUrlBtn.classList.add("copied");
        copyUrlBtn.innerHTML = CHECK_ICON;
        window.setTimeout(() => {
          copyUrlBtn.classList.remove("copied");
          copyUrlBtn.innerHTML = COPY_ICON;
        }, 1600);
      },
      () => showError("Could not copy the URL."),
    );
    return;
  }
  const copyBtn = target?.closest<HTMLButtonElement>("[data-copy-id]");
  if (!copyBtn?.dataset.copyId) return;
  ev.preventDefault();
  ev.stopPropagation();
  const id = copyBtn.dataset.copyId;
  void navigator.clipboard.writeText(id).then(
    () => {
      copyBtn.classList.add("copied");
      copyBtn.innerHTML = `Copied ${CHECK_ICON}`;
      window.setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.innerHTML = `ID ${COPY_ICON}`;
      }, 1600);
    },
    () => showError("Could not copy the ID."),
  );
});

async function startLogin() {
  enrollConnectStarted = false;
  if (isEnrolled()) {
    $("enroll-panel").classList.remove("hidden");
    showPage("settings");
  }
  setEnrollButtonsDisabled(true);
  applyEnrollPhase({ kind: "starting" });
  try {
    applyEnrollPhase(await invoke("enroll_start"));
  } catch (e) {
    setEnrollButtonsDisabled(false);
    showError(invokeError(e));
  }
}

function applyEnrollPhase(phase: Snapshot["enroll_phase"]) {
  $("enroll-panel").classList.remove("hidden");
  if (phase.kind === "starting" || phase.kind === "submitting") {
    setEnrollCopy(phase.kind === "starting" ? "Opening the browser…" : "Submitting code…");
    setEnrollButtonsDisabled(phase.kind === "starting");
  }
  if (phase.kind === "failed") {
    setEnrollButtonsDisabled(false);
    setEnrollCopy(phase.message || "Enrollment failed.");
    showError(phase.message || "Enrollment failed.");
  }
  if (phase.kind === "browser_opened" && phase.url) {
    setEnrollButtonsDisabled(false);
    document.querySelectorAll(".enroll-url-wrap").forEach((el) => el.classList.remove("hidden"));
    document.querySelectorAll(".enroll-code-wrap").forEach((el) => el.classList.remove("hidden"));
    document.querySelectorAll<HTMLAnchorElement>(".enroll-url").forEach((a) => {
      a.href = phase.url ?? "#";
      a.textContent = phase.url ?? "open the enroll URL";
    });
    setEnrollCopy("Finish in the browser, then enter the code.");
  }
  if (phase.kind === "awaiting_code" || phase.kind === "wrong_code") {
    setEnrollButtonsDisabled(false);
    document.querySelectorAll(".enroll-code-wrap").forEach((el) => el.classList.remove("hidden"));
    setEnrollCopy(
      phase.kind === "wrong_code"
        ? "Wrong code — try again."
        : "Enter the code from the browser.",
    );
  }
  if (phase.kind === "succeeded") {
    setEnrollButtonsDisabled(false);
    showError(null);
    setEnrollCopy(`Enrolled${phase.org ? ` in ${phase.org}` : ""}.`);
    if (enrollConnectStarted) return;
    enrollConnectStarted = true;
    void refreshOrgs().then(async (ok) => {
      const snap = await invoke<Snapshot>("get_snapshot").catch(() => null);
      if (snap) hostname = snap.agent_name;
      applyAgentName();
      if (ok) {
        await refreshCatalog();
        await invoke("start_connect", { region: null }).catch((e) => showError(invokeError(e)));
      }
    });
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  endpointSelect = new HdSelect($("tap-endpoint"));
  destSelect = new HdSelect($("tap-dest"));
  hdSelects.push(endpointSelect, destSelect);
  endpointSelect.onChange = () => fillDestinations();
  destSelect.onChange = () => applyDestSelection();

  applyAgentName();
  renderAll();

  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page as Page));
  });

  $("org-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    $("org-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (ev) => {
    const switcher = document.querySelector(".org-switcher");
    if (switcher && !switcher.contains(ev.target as Node)) {
      $("org-menu").classList.add("hidden");
    }
  });

  $("open-create-tap").addEventListener("click", () => setDialogOpen(true));
  $("close-create-tap").addEventListener("click", () => setDialogOpen(false));
  $("cancel-create-tap").addEventListener("click", () => setDialogOpen(false));
  $("tap-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("tap-dialog")) setDialogOpen(false);
  });
  $("confirm-cancel").addEventListener("click", () => {
    pendingEndTaps = null;
    setConfirmOpen(false);
  });
  $("confirm-ok").addEventListener("click", () => {
    void confirmEndTap();
  });
  $("confirm-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("confirm-dialog")) {
      pendingEndTaps = null;
      setConfirmOpen(false);
    }
  });
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target?.closest(".hd-select")) closeHdSelects();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeHdSelects();
  });
  window.addEventListener("resize", () => closeHdSelects());
  $("refresh-ports").addEventListener("click", () => {
    void refreshPorts().catch((e) => showError(String(e)));
  });
  $("port-filter").addEventListener("input", () => {
    renderPorts();
  });
  $("ep-search").addEventListener("input", () => {
    endpointsPage = 1;
    renderEndpointsPage();
  });
  $("tap-port").addEventListener("input", updateTapTarget);
  $("tap-path").addEventListener("input", updateTapTarget);
  $("start-tap").addEventListener("click", async () => {
    if (!selectedDest) return;
    const port = Number(($("tap-port") as HTMLInputElement).value);
    const path = ($("tap-path") as HTMLInputElement).value || "/";
    const ep = catalog.endpoints.find((e) => e.id === selectedDest?.endpointId);
    const dest = ep?.destinations.find((d) => d.id === selectedDest?.destId);
    try {
      await invoke<TapHandle>("create_tap", {
        endpointId: selectedDest.endpointId,
        destinationId: selectedDest.destId,
        port,
        path,
        noTty: true,
      });
      upsertSaved({
        id: savedId(selectedDest.endpointId, selectedDest.destId, port, path),
        endpointId: selectedDest.endpointId,
        endpointName: ep?.name ?? selectedDest.endpointId,
        destId: selectedDest.destId,
        destName: dest?.name ?? "Raw incoming webhook",
        port,
        path,
      });
      setDialogOpen(false);
      showPage("taps");
      await refreshCatalog();
    } catch (e) {
      showError(String(e));
    }
  });

  $("rename-agent").addEventListener("click", () => {
    showPage("settings");
    const input = $("settings-name") as HTMLInputElement;
    input.focus();
    input.select();
  });
  $("save-name").addEventListener("click", async () => {
    const btn = $("save-name") as HTMLButtonElement;
    const label = btn.textContent ?? "Save name";
    const value = ($("settings-name") as HTMLInputElement).value.trim();
    btn.disabled = true;
    showError(null);
    try {
      await invoke<string>("rename_agent", { name: value });
      if (value) localStorage.setItem(NAME_KEY, value);
      else localStorage.removeItem(NAME_KEY);
      applyAgentName();
      btn.textContent = "Saved";
      window.setTimeout(() => {
        btn.textContent = label;
      }, 1600);
    } catch (e) {
      showError(invokeError(e));
    } finally {
      btn.disabled = false;
    }
  });
  $("settings-add-org").addEventListener("click", () => {
    void startLogin();
  });
  document.querySelectorAll<HTMLButtonElement>(".enroll-start").forEach((btn) => {
    btn.addEventListener("click", () => {
      void startLogin();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".enroll-submit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        applyEnrollPhase(await invoke("enroll_submit_code", { code: enrollCodeValue() }));
      } catch (e) {
        showError(invokeError(e));
      }
    });
  });
  document.querySelectorAll<HTMLAnchorElement>(".enroll-url").forEach((a) => {
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (a.href) await openUrl(a.href);
    });
  });

  await listen<ConnectStatus>("connect-status", (e) => applyStatus(e.payload));
  await listen<Snapshot["enroll_phase"]>("enroll-progress", (e) => applyEnrollPhase(e.payload));

  let pendingEnroll: Snapshot["enroll_phase"] | null = null;
  try {
    const snap = await invoke<Snapshot>("get_snapshot");
    hostname = snap.agent_name;
    applyStatus(snap.status);
    pendingEnroll = snap.enroll_phase;
  } catch {
    applyAgentName();
  }

  const enrolled = await refreshOrgs();
  if (
    !enrolled &&
    pendingEnroll &&
    pendingEnroll.kind !== "idle" &&
    pendingEnroll.kind !== "succeeded"
  ) {
    applyEnrollPhase(pendingEnroll);
  }
  if (enrolled) {
    try {
      await refreshCatalog();
    } catch (e) {
      showError(invokeError(e));
    }
    try {
      await invoke("start_connect", { region: null });
    } catch (e) {
      showError(invokeError(e));
    }
  }
});
