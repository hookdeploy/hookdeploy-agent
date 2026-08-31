import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

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
  online?: boolean;
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
  favorite?: boolean;
}

const NAME_KEY = "hookdeploy.agentName";
const SAVED_KEY = "hookdeploy.savedTaps";
const RECENT_LIMIT = 5;
const EP_PAGE_SIZE = 10;
const PAGES: Record<Page, { title: string; desc: string }> = {
  dashboard: { title: "Dashboard", desc: "Overview of this agent" },
  endpoints: { title: "Endpoints", desc: "Endpoints in this organization" },
  taps: { title: "Taps", desc: "Live taps, favorites, and recent shortcuts" },
  settings: { title: "Settings", desc: "This agent and enrollment" },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TAP_ICON =
  '<svg width="14" height="14" viewBox="1 3.5 22 18.5" fill="none" aria-hidden="true"><rect x="2" y="5" width="20" height="7" rx="3.5" stroke="currentColor" stroke-width="2"/><path d="M12 12v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 20h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>';
const CHECK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MORE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
const ENDPOINT_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5.93" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 11a5 5 0 0 0-7.07 0L5.52 12.41a5 5 0 0 0 7.07 7.07L14 18.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const DEST_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="18" y="5" width="3" height="14" rx="1" stroke="currentColor" stroke-width="2"/></svg>';

let orgs: OrgInfo[] = [];
let catalog: Catalog = { endpoints: [], taps: [] };
let ports: PortInfo[] = [];
let hostname: string | null = null;
let endpointsPage = 1;
let selectedDest: { endpointId: string; destId: string | null } | null = null;
let pendingEndTaps: { tapIds: string[]; endpointName: string } | null = null;
let pendingStarts: Array<{
  key: string;
  endpoint: string;
  destination: string;
  port: number;
  path: string;
}> = [];
let expiryTimer: number | null = null;
let connectPhase: Phase = "disconnected";
let osOnline = true;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyOffline() {
  $("offline").classList.toggle("hidden", osOnline && navigator.onLine);
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

function connectionLive(phase: Phase): boolean {
  return phase === "connected" || phase === "connecting" || phase === "reconnecting";
}

function applyStatus(s: ConnectStatus) {
  connectPhase = s.phase;
  $("status-dot").className = `dot ${s.phase}`;
  $("status-phase").textContent = s.phase[0].toUpperCase() + s.phase.slice(1);
  const live = connectionLive(s.phase);
  $("conn-opt-connected").querySelector(".conn-check")?.classList.toggle("hidden", !live);
  $("conn-opt-disconnected").querySelector(".conn-check")?.classList.toggle("hidden", live);
  const btn = $("conn-btn") as HTMLButtonElement;
  btn.disabled = s.phase === "revoked";
  if (s.phase === "revoked") closeConnMenu();
  const relay = $("status-relay");
  if (s.relay && live) {
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

function closeConnMenu() {
  $("conn-menu").classList.add("hidden");
  $("conn-btn").setAttribute("aria-expanded", "false");
}

async function setConnection(want: "connected" | "disconnected") {
  if (connectPhase === "revoked") return;
  const live = connectionLive(connectPhase);
  showError(null);
  try {
    if (want === "connected" && !live) {
      await invoke("start_connect", { region: null });
    } else if (want === "disconnected" && live) {
      await invoke("stop_connect");
    }
  } catch (e) {
    showError(invokeError(e));
  }
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
  all[activeOrgId()] = pruneSaved(rows);
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
}

function pruneSaved(rows: SavedTap[]): SavedTap[] {
  const distinct: SavedTap[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    distinct.push(row);
  }
  const recent = distinct.slice(0, RECENT_LIMIT);
  const recentIds = new Set(recent.map((s) => s.id));
  return [...recent, ...distinct.filter((s) => s.favorite && !recentIds.has(s.id))];
}

function upsertSaved(tap: SavedTap) {
  const rows = loadSaved();
  const prev = rows.find((s) => s.id === tap.id);
  const next: SavedTap = {
    ...prev,
    ...tap,
    favorite: tap.favorite ?? prev?.favorite ?? false,
  };
  persistSaved([next, ...rows.filter((s) => s.id !== tap.id)]);
}

function isFavorite(id: string): boolean {
  return loadSaved().some((s) => s.id === id && s.favorite);
}

function setFavorite(id: string, on: boolean) {
  const row = loadSaved().find((s) => s.id === id);
  if (!row) return;
  upsertSaved({ ...row, favorite: on });
}

function savedFromLive(t: TapInfo): SavedTap {
  const { port, path } = tapPortPath(t.target);
  const ep = catalog.endpoints.find((e) => e.name === t.endpoint || e.id === t.endpoint);
  const dest = ep?.destinations.find((d) => d.name === t.destination);
  const destId = dest?.id ?? null;
  const endpointId = ep?.id ?? t.endpoint;
  const destName =
    t.destination && t.destination !== "(endpoint)" ? t.destination : "Raw incoming webhook";
  return {
    id: savedId(endpointId, destId, Number(port) || 0, path),
    endpointId,
    endpointName: ep?.name ?? t.endpoint,
    destId,
    destName,
    port: Number(port) || 0,
    path,
    favorite: true,
  };
}

function savedMatchingLive(t: TapInfo): SavedTap | undefined {
  const mapped = savedFromLive(t);
  return loadSaved().find((s) => s.id === mapped.id) ?? liveForSavedMatch(t);
}

function liveForSavedMatch(t: TapInfo): SavedTap | undefined {
  return loadSaved().find((s) => liveForSaved(s)?.id === t.id);
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

function liveForSaved(saved: SavedTap): TapInfo | undefined {
  const target = `127.0.0.1:${saved.port}${saved.path}`;
  return catalog.taps.find(
    (t) =>
      t.target === target &&
      (t.endpoint === saved.endpointName || t.endpoint === saved.endpointId),
  );
}

function emptyTray(message: string): string {
  return `<div class="table-empty">${escapeHtml(message)}</div>`;
}

function tableWrap(head: string, body: string, tableClass?: string): string {
  const cls = tableClass ? ` class="${tableClass}"` : "";
  return `<table${cls}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function tapPortPath(target: string): { port: string; path: string } {
  const rest = target.replace(/^127\.0\.0\.1:/, "");
  const slash = rest.indexOf("/");
  if (slash < 0) return { port: rest || "—", path: "/" };
  return { port: rest.slice(0, slash) || "—", path: rest.slice(slash) || "/" };
}

function formatRemaining(iso: string): string {
  const end = Date.parse(iso);
  if (Number.isNaN(end)) return iso;
  const ms = end - Date.now();
  if (ms <= 0) return "Expired";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tickExpiryCells() {
  document.querySelectorAll<HTMLElement>("[data-expires]").forEach((el) => {
    const iso = el.dataset.expires;
    if (!iso) return;
    el.textContent = formatRemaining(iso);
  });
}

function ensureExpiryTicker() {
  if (expiryTimer != null) return;
  expiryTimer = window.setInterval(tickExpiryCells, 1000);
}

function tapsTableHead(last: string): string {
  return `<th class="col-tap">Endpoint / Destination</th><th class="col-port">Port</th><th class="col-path">Path</th><th class="col-meta">${last}</th><th class="col-actions"></th>`;
}

function tapPairCell(endpoint: string, destination: string): string {
  const dest = destination.trim() || "(endpoint)";
  return `<div class="tap-pair">
    <div class="tap-pair-line tap-pair-ep">
      <span class="tap-pair-icon" aria-hidden="true">${ENDPOINT_ICON}</span>
      <span class="tap-pair-text">${escapeHtml(endpoint)}</span>
    </div>
    <div class="tap-pair-line tap-pair-dest">
      <span class="tap-pair-icon" aria-hidden="true">${DEST_ICON}</span>
      <span class="tap-pair-text">${escapeHtml(dest)}</span>
    </div>
  </div>`;
}

function menuItem(label: string, attrs: string, extraClass = ""): string {
  const cls = extraClass ? `row-menu-item ${extraClass}` : "row-menu-item";
  return `<button type="button" class="${cls}" role="menuitem" ${attrs}>${label}</button>`;
}

function copyIdButton(id: string, label: string): string {
  return `<button type="button" class="copy-id" data-copy-id="${escapeHtml(id)}" title="${escapeHtml(id)}" aria-label="Copy ${escapeHtml(label.toLowerCase())}">ID ${COPY_ICON}</button>`;
}

function endpointPublicUrl(ep: Pick<EndpointInfo, "url">): string {
  return ep.url?.trim() ?? "";
}

function endpointTitleCell(name: string, id: string): string {
  return `<div class="cell-endpoint"><div class="cell-title-row"><div class="cell-title">${escapeHtml(name)}</div>${copyIdButton(id, "Endpoint ID")}</div></div>`;
}

function endpointUrlCell(url?: string | null): string {
  const trimmed = url?.trim() ?? "";
  if (!trimmed) return `<span class="muted">—</span>`;
  return `<div class="cell-url">
        <span class="cell-url-text mono" title="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>
        <button type="button" class="copy-url" data-copy-url="${escapeHtml(trimmed)}" title="Copy URL" aria-label="Copy endpoint URL">${COPY_ICON}</button>
      </div>`;
}

function endpointNameCell(name: string, id: string, url?: string | null): string {
  const urlRow = url?.trim() ? endpointUrlCell(url) : "";
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
  $("dash-tap-count").textContent = String(catalog.taps.length + pendingStarts.length);

  $("dash-inbound").innerHTML = inbound.length
    ? tableWrap(
        `<th>Endpoint</th><th>URL</th>`,
        inbound
          .map(
            (ep) =>
              `<tr><td>${endpointTitleCell(ep.name, ep.id)}</td><td>${endpointUrlCell(endpointPublicUrl(ep))}</td></tr>`,
          )
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

function closeRowMenus() {
  document.querySelectorAll<HTMLElement>(".row-menu-pop").forEach((pop) => {
    pop.classList.add("hidden");
    pop.style.top = "";
    pop.style.left = "";
    pop.style.position = "";
  });
  document.querySelectorAll<HTMLButtonElement>(".row-menu-btn").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
}

function positionRowMenu(btn: HTMLElement, pop: HTMLElement) {
  const rect = btn.getBoundingClientRect();
  pop.classList.remove("hidden");
  pop.style.position = "fixed";
  pop.style.visibility = "hidden";
  const width = pop.offsetWidth || 148;
  const height = pop.offsetHeight || 40;
  let left = rect.right - width;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.visibility = "";
}

function bindRowMenus() {
  document.querySelectorAll<HTMLButtonElement>(".row-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const wrap = btn.closest(".row-menu");
      const pop = wrap?.querySelector<HTMLElement>(".row-menu-pop");
      if (!pop) return;
      const open = pop.classList.contains("hidden");
      closeRowMenus();
      if (!open) return;
      btn.setAttribute("aria-expanded", "true");
      positionRowMenu(btn, pop);
    });
  });
}

function tapRowMenu(items: string): string {
  return `<div class="row-menu">
    <button type="button" class="row-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Tap actions">${MORE_ICON}</button>
    <div class="row-menu-pop hidden" role="menu">${items}</div>
  </div>`;
}

function favoriteMenuItem(id: string, fav: boolean): string {
  return fav
    ? menuItem("Remove from favorites", `data-unfav="${escapeHtml(id)}"`)
    : menuItem("Add to favorites", `data-fav="${escapeHtml(id)}"`);
}

function liveTapRow(t: TapInfo): string {
  const { port, path } = tapPortPath(t.target);
  const saved = savedMatchingLive(t);
  const favId = saved?.id ?? savedFromLive(t).id;
  const expires = t.expires
    ? `<span class="cell-timer" data-expires="${escapeHtml(t.expires)}" title="${escapeHtml(t.expires)}">${escapeHtml(formatRemaining(t.expires))}</span>`
    : "—";
  const items = [
    menuItem("Stop tap", `data-stop="${escapeHtml(t.id)}"`, "danger"),
    favoriteMenuItem(favId, isFavorite(favId)),
  ].join("");
  return `<tr>
    <td class="col-tap">${tapPairCell(t.endpoint, t.destination || "(endpoint)")}</td>
    <td class="col-port mono">${escapeHtml(port)}</td>
    <td class="col-path mono">${escapeHtml(path)}</td>
    <td class="col-meta">${expires}</td>
    <td class="col-actions">${tapRowMenu(items)}</td>
  </tr>`;
}

function pendingTapRow(p: (typeof pendingStarts)[number]): string {
  return `<tr class="tap-pending">
    <td class="col-tap">${tapPairCell(p.endpoint, p.destination)}</td>
    <td class="col-port mono">${escapeHtml(String(p.port))}</td>
    <td class="col-path mono">${escapeHtml(p.path)}</td>
    <td class="col-meta cell-sub">Starting…</td>
    <td class="col-actions"></td>
  </tr>`;
}

function liveTapsTable(): string {
  const pending = pendingStarts.filter(
    (p) =>
      !catalog.taps.some((t) => {
        const { port, path } = tapPortPath(t.target);
        return (
          port === String(p.port) &&
          path === p.path &&
          (t.endpoint === p.endpoint || t.endpoint === p.key)
        );
      }),
  );
  if (!catalog.taps.length && !pending.length) {
    return emptyTray("No live taps. A tap stays listed until it expires or is stopped.");
  }
  return tableWrap(
    tapsTableHead("Expires"),
    pending.map(pendingTapRow).concat(catalog.taps.map(liveTapRow)).join(""),
    "taps-table",
  );
}

async function startLiveTap(opts: {
  endpointId: string;
  endpointName: string;
  destId: string | null;
  destName: string;
  port: number;
  path: string;
  save: boolean;
}): Promise<void> {
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const key = savedId(opts.endpointId, opts.destId, opts.port, path);
  if (!pendingStarts.some((p) => p.key === key)) {
    pendingStarts.push({
      key,
      endpoint: opts.endpointName,
      destination: opts.destName,
      port: opts.port,
      path,
    });
  }
  showError(null);
  showPage("taps");
  renderAll();
  try {
    const handle = await invoke<TapHandle>("create_tap", {
      endpointId: opts.endpointId,
      destinationId: opts.destId,
      port: opts.port,
      path,
      noTty: true,
    });
    if (opts.save) {
      upsertSaved({
        id: key,
        endpointId: opts.endpointId,
        endpointName: opts.endpointName,
        destId: opts.destId,
        destName: opts.destName,
        port: opts.port,
        path,
      });
    }
    if (!catalog.taps.some((t) => t.id === handle.id)) {
      catalog.taps.unshift({
        id: handle.id,
        endpoint: opts.endpointName,
        destination: opts.destName === "Raw incoming webhook" ? "" : opts.destName,
        target: handle.target || `127.0.0.1:${opts.port}${path}`,
        expires: null,
      });
    }
    pendingStarts = pendingStarts.filter((p) => p.key !== key);
    renderAll();
    void refreshCatalog().catch((e) => showError(invokeError(e)));
  } catch (e) {
    pendingStarts = pendingStarts.filter((p) => p.key !== key);
    showError(invokeError(e));
    renderAll();
  }
}

function shortcutStatus(s: SavedTap): string {
  if (liveForSaved(s)) return `<span class="fwd-badge">Active</span>`;
  if (pendingStarts.some((p) => p.key === s.id)) return `<span class="cell-sub">Starting…</span>`;
  return `<span class="muted">Idle</span>`;
}

function shortcutRow(s: SavedTap, kind: "recent" | "favorite"): string {
  const live = liveForSaved(s);
  const starting = pendingStarts.some((p) => p.key === s.id);
  const items: string[] = [];
  if (live) items.push(menuItem("Stop tap", `data-stop="${escapeHtml(live.id)}"`, "danger"));
  else {
    items.push(
      menuItem(
        starting ? "Starting…" : "Start Tap",
        `data-enable="${escapeHtml(s.id)}"${starting ? " disabled" : ""}`,
      ),
    );
  }
  items.push(favoriteMenuItem(s.id, !!s.favorite));
  if (kind === "recent") {
    items.push(menuItem("Remove", `data-forget="${escapeHtml(s.id)}"`));
  }
  return `<tr>
    <td class="col-tap">${tapPairCell(s.endpointName, s.destName)}</td>
    <td class="col-port mono">${escapeHtml(String(s.port))}</td>
    <td class="col-path mono">${escapeHtml(s.path)}</td>
    <td class="col-meta">${shortcutStatus(s)}</td>
    <td class="col-actions">${tapRowMenu(items.join(""))}</td>
  </tr>`;
}

function renderShortcutTable(
  el: HTMLElement,
  rows: SavedTap[],
  kind: "recent" | "favorite",
  empty: string,
) {
  el.innerHTML = rows.length
    ? tableWrap(tapsTableHead("Status"), rows.map((s) => shortcutRow(s, kind)).join(""), "taps-table")
    : emptyTray(empty);
}

function renderTapsPage() {
  $("taps-live").innerHTML = liveTapsTable();
  const saved = loadSaved();
  renderShortcutTable(
    $("taps-favorites"),
    saved.filter((s) => s.favorite),
    "favorite",
    "No favorites yet. Add one from an active or recent tap.",
  );
  renderShortcutTable(
    $("taps-saved"),
    saved.slice(0, RECENT_LIMIT),
    "recent",
    "No recent taps yet. Start a tap to keep its port and path here.",
  );

  document.querySelectorAll<HTMLButtonElement>("[data-enable]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const savedTap = loadSaved().find((s) => s.id === btn.dataset.enable);
      if (!savedTap) return;
      void startLiveTap({
        endpointId: savedTap.endpointId,
        endpointName: savedTap.endpointName,
        destId: savedTap.destId,
        destName: savedTap.destName,
        port: savedTap.port,
        path: savedTap.path,
        save: true,
      });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-forget]").forEach((btn) => {
    btn.addEventListener("click", () => {
      persistSaved(loadSaved().filter((s) => s.id !== btn.dataset.forget));
      renderAll();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-fav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.fav;
      if (!id) return;
      const existing = loadSaved().find((s) => s.id === id);
      if (existing) setFavorite(id, true);
      else {
        const live = catalog.taps.find((t) => savedFromLive(t).id === id);
        if (live) upsertSaved(savedFromLive(live));
      }
      renderAll();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-unfav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.unfav) setFavorite(btn.dataset.unfav, false);
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
  bindRowMenus();
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

let pendingUpdate: Update | null = null;

function setUpdateStatus(text: string) {
  const el = document.getElementById("update-status");
  if (el) el.textContent = text;
}

async function checkForUpdates(interactive: boolean) {
  const btn = document.getElementById("check-updates") as HTMLButtonElement | null;
  const foot = document.getElementById("update-foot");
  if (btn) btn.disabled = true;
  if (interactive) setUpdateStatus("Checking…");
  try {
    const update = await check();
    pendingUpdate = update;
    if (!update) {
      if (foot) foot.classList.add("hidden");
      setUpdateStatus("You’re up to date.");
      return;
    }
    if (foot) foot.classList.remove("hidden");
    setUpdateStatus(`Version ${update.version} is available.`);
  } catch (e) {
    pendingUpdate = null;
    if (foot) foot.classList.add("hidden");
    if (interactive) setUpdateStatus(invokeError(e));
    else setUpdateStatus("Could not check for updates.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function installPendingUpdate() {
  if (!pendingUpdate) return;
  const btn = document.getElementById("install-update") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setUpdateStatus("Downloading update…");
  try {
    await pendingUpdate.downloadAndInstall();
    setUpdateStatus("Restarting…");
    await relaunch();
  } catch (e) {
    setUpdateStatus(invokeError(e));
    if (btn) btn.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  applyOffline();
  window.addEventListener("online", applyOffline);
  window.addEventListener("offline", applyOffline);

  endpointSelect = new HdSelect($("tap-endpoint"));
  destSelect = new HdSelect($("tap-dest"));
  hdSelects.push(endpointSelect, destSelect);
  endpointSelect.onChange = () => fillDestinations();
  destSelect.onChange = () => applyDestSelection();

  applyAgentName();
  ensureExpiryTicker();
  renderAll();

  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page as Page));
  });

  $("org-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeConnMenu();
    $("org-menu").classList.toggle("hidden");
  });
  $("conn-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (connectPhase === "revoked") return;
    $("org-menu").classList.add("hidden");
    const menu = $("conn-menu");
    const open = menu.classList.toggle("hidden") === false;
    $("conn-btn").setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("conn-menu").querySelectorAll<HTMLButtonElement>("[data-conn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeConnMenu();
      const want = btn.dataset.conn;
      if (want === "connected" || want === "disconnected") {
        void setConnection(want);
      }
    });
  });
  document.addEventListener("click", (ev) => {
    const target = ev.target as Node;
    const org = document.querySelector(".org-switcher");
    if (org && !org.contains(target)) {
      $("org-menu").classList.add("hidden");
    }
    const conn = document.querySelector(".conn-switcher");
    if (conn && !conn.contains(target)) {
      closeConnMenu();
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
    if (!target?.closest(".row-menu")) closeRowMenus();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeHdSelects();
      closeRowMenus();
      closeConnMenu();
      $("org-menu").classList.add("hidden");
    }
  });
  window.addEventListener("resize", () => {
    closeHdSelects();
    closeRowMenus();
  });
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
  $("start-tap").addEventListener("click", () => {
    if (!selectedDest) return;
    const port = Number(($("tap-port") as HTMLInputElement).value);
    const path = ($("tap-path") as HTMLInputElement).value || "/";
    if (!port) return;
    const ep = catalog.endpoints.find((e) => e.id === selectedDest?.endpointId);
    const dest = ep?.destinations.find((d) => d.id === selectedDest?.destId);
    setDialogOpen(false);
    void startLiveTap({
      endpointId: selectedDest.endpointId,
      endpointName: ep?.name ?? selectedDest.endpointId,
      destId: selectedDest.destId,
      destName: dest?.name ?? "Raw incoming webhook",
      port,
      path,
      save: true,
    });
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
  const versionEl = document.getElementById("settings-version");
  if (versionEl) {
    try {
      versionEl.textContent = await getVersion();
    } catch {
      versionEl.textContent = "—";
    }
  }
  $("check-updates").addEventListener("click", () => {
    void checkForUpdates(true);
  });
  $("install-update").addEventListener("click", () => {
    void installPendingUpdate();
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

  await listen<boolean>("network-online", (e) => {
    osOnline = e.payload;
    applyOffline();
  });
  await listen<ConnectStatus>("connect-status", (e) => applyStatus(e.payload));
  await listen<Snapshot["enroll_phase"]>("enroll-progress", (e) => applyEnrollPhase(e.payload));

  let pendingEnroll: Snapshot["enroll_phase"] | null = null;
  try {
    const snap = await invoke<Snapshot>("get_snapshot");
    hostname = snap.agent_name;
    applyStatus(snap.status);
    if (typeof snap.online === "boolean") {
      osOnline = snap.online;
      applyOffline();
    }
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
  void checkForUpdates(false);
});
