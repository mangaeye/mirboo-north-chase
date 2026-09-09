const providers = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    note: "OpenStreetMap · © OpenStreetMap contributors"
  },
  carto: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap © CARTO",
    note: "Carto Voyager · © OpenStreetMap © CARTO"
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri",
    note: "Esri World Imagery · Tiles © Esri"
  }
};

let loadedRoute = null;
const runnerLayer = L.layerGroup();
const map = L.map("map", { zoomControl: false, scrollWheelZoom: false }).setView([-38.4, 146.16], 13);
L.control.zoom({ position: "bottomright" }).addTo(map);
let activeLayer = L.tileLayer(providers.osm.url, { attribution: providers.osm.attribution, maxZoom: 18 }).addTo(map);
runnerLayer.addTo(map);

loadKmlRoute();

async function loadKmlRoute() {
  try {
    const response = await fetch("route.kml");
    if (!response.ok) throw new Error(`Could not load route.kml (${response.status})`);
    const kml = new DOMParser().parseFromString(await response.text(), "application/xml");
    const coordinateText = [...kml.querySelectorAll("LineString coordinates")]
      .map((element) => element.textContent)
      .join(" ");
    const route = coordinateText.trim().split(/\s+/).map((point) => {
      const [longitude, latitude] = point.split(",").map(Number);
      return [latitude, longitude];
    }).filter(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude));
    if (route.length < 2) throw new Error("route.kml does not contain a usable LineString route");

    const routeLine = L.polyline(route, { color: "#f76b45", weight: 5, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });
    loadedRoute = route;
    await addRunnerMarkers(route);
    mapNote.textContent = "Route loaded from route.kml";
  } catch (error) {
    console.error(error);
    showToast("Could not load route.kml. Run the site through a local web server.");
  }
}

async function addRunnerMarkers(route) {
  const runners = await loadRealRunners();
  runnerLayer.clearLayers();
  const segmentDistances = route.slice(1).map((point, index) => map.distance(route[index], point) / 1000);
  const totalDistance = segmentDistances.reduce((sum, distance) => sum + distance, 0);
  const cumulativeDistances = [0];
  segmentDistances.forEach((distance) => cumulativeDistances.push(cumulativeDistances.at(-1) + distance));

  runners.forEach((runner) => {
    const distanceAlongRoute = Math.min(runner.distanceKm, totalDistance);
    let segmentIndex = cumulativeDistances.findIndex((distance) => distance >= distanceAlongRoute);
    if (segmentIndex < 1) segmentIndex = 1;
    const segmentStart = route[segmentIndex - 1];
    const segmentEnd = route[segmentIndex];
    const segmentDistance = cumulativeDistances[segmentIndex] - cumulativeDistances[segmentIndex - 1];
    const segmentProgress = segmentDistance === 0
      ? 0
      : (distanceAlongRoute - cumulativeDistances[segmentIndex - 1]) / segmentDistance;
    const position = [
      segmentStart[0] + (segmentEnd[0] - segmentStart[0]) * segmentProgress,
      segmentStart[1] + (segmentEnd[1] - segmentStart[1]) * segmentProgress
    ];
    const initials = runner.name.slice(0, 2).toUpperCase();
    const icon = L.divIcon({
      className: "runner-marker",
      html: `<span style="background:${runner.color}">${initials}</span>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
    L.marker(position, { icon })
      .addTo(runnerLayer)
      .bindTooltip(`${runner.name} · ${runner.distanceKm} km`, {
        direction: "top",
        offset: [0, -14],
        permanent: true,
        className: "runner-tooltip"
      });
  });
}

async function loadRealRunners() {
  if (!authClient) {
    renderRunnerData([]);
    return [];
  }
  const [profilesResult, entriesResult] = await Promise.all([
    authClient.from("profiles").select("id, display_name"),
    authClient.from("race_entries").select("user_id, distance_km")
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (entriesResult.error) throw entriesResult.error;
  const distances = new Map(entriesResult.data.map((entry) => [entry.user_id, Number(entry.distance_km) || 0]));
  const runners = profilesResult.data.map((profile, index) => ({
    id: profile.id,
    name: profile.display_name,
    distanceKm: distances.get(profile.id) || 0,
    color: ["#f76b45", "#6e59d9", "#3a9d78", "#d49a32"][index % 4]
  })).sort((a, b) => b.distanceKm - a.distanceKm);
  renderRunnerData(runners);
  return runners;
}

function renderRunnerData(runners) {
  const totalDistance = runners.reduce((sum, runner) => sum + runner.distanceKm, 0);
  document.getElementById("runnerCount").textContent = runners.length;
  document.getElementById("totalDistance").textContent = Math.round(totalDistance);
  document.getElementById("eventDistance").textContent = `${Math.round(totalDistance)} km complete`;
  document.getElementById("eventPercent").textContent = `${Math.min(100, Math.round(totalDistance / 1336 * 100))}%`;
  document.querySelector(".event-progress span").style.width = `${Math.min(100, totalDistance / 1336 * 100)}%`;
  const rows = document.getElementById("leaderboardRows");
  rows.innerHTML = runners.length ? runners.slice(0, 5).map((runner, index) => `
    <div class="leader-row">
      <span class="rank ${index === 0 ? "first" : ""}">${String(index + 1).padStart(2, "0")}</span>
      <span class="mini-avatar" style="background:${runner.color}">${runner.name.slice(0, 2).toUpperCase()}</span>
      <div class="runner-name"><strong>${escapeHtml(runner.name)}</strong><small>${runner.distanceKm} km along route</small></div>
      <strong class="distance">${runner.distanceKm} <small>km</small></strong>
    </div>`).join("") : '<p class="empty-state">No runners have joined yet.</p>';
  updatePersonalProgress(runners);
}

function updatePersonalProgress(runners) {
  const currentName = currentUser?.user_metadata?.display_name;
  const currentRunner = runners.find((runner) => runner.name === currentName);
  const distance = currentRunner?.distanceKm || 0;
  document.getElementById("progressTitle").textContent = currentName
    ? `${currentName}, keep going!`
    : "Sign in to track your progress";
  document.getElementById("personalDistance").textContent = distance;
  document.getElementById("personalProgressBar").style.width = `${Math.min(100, distance / 1336 * 100)}%`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

const mapSelect = document.getElementById("mapProvider");
const mapNote = document.getElementById("mapNote");
mapSelect.addEventListener("change", (event) => {
  const provider = event.target.value;
  if (provider === "google") {
    window.open("https://www.google.com/maps/@-25.2744,133.7751,4z", "_blank", "noopener");
    event.target.value = "osm";
    showToast("Google Maps opened in a new tab");
    return;
  }
  map.removeLayer(activeLayer);
  activeLayer = L.tileLayer(providers[provider].url, { attribution: providers[provider].attribution, maxZoom: 18 }).addTo(map);
  activeLayer.bringToBack();
  mapNote.textContent = providers[provider].note;
});

const joinModal = document.getElementById("joinModal");
const connectModal = document.getElementById("connectModal");
document.getElementById("joinButton").addEventListener("click", async () => {
  if (!currentUser) {
    authModal.hidden = false;
    authName.focus();
    return;
  }
  if (!authClient) {
    showToast("Connect Supabase before joining the race");
    return;
  }
  const { error } = await authClient.from("race_entries").upsert(
    { user_id: currentUser.id, race_name: "Race around Australia", distance_km: 0 },
    { onConflict: "user_id,race_name" }
  );
  if (error) {
    showToast(error.message);
    return;
  }
  showToast("You joined the race");
  if (loadedRoute) await addRunnerMarkers(loadedRoute);
});
document.getElementById("connectButton").addEventListener("click", () => { connectModal.hidden = false; });
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { document.getElementById(button.dataset.close).hidden = true; }));
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) backdrop.hidden = true; }));
document.getElementById("joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("runnerName").value.trim();
  if (!name) return;
  localStorage.setItem("mirbooRunnerName", name);
  document.querySelector(".profile-name").firstChild.textContent = `${name} `;
  document.getElementById("runnerCount").textContent = "129";
  joinModal.hidden = true;
  showToast(`Welcome to the chase, ${name}!`);
  event.target.reset();
});
document.querySelectorAll("[data-provider]").forEach((button) => button.addEventListener("click", () => {
  connectModal.hidden = true;
  showToast(`${button.dataset.provider} connection will be available soon`);
}));

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}

const savedName = localStorage.getItem("mirbooRunnerName");
if (savedName) document.querySelector(".profile-name").firstChild.textContent = `${savedName} `;

let authMode = "signup";
let currentUser = null;
const authModal = document.getElementById("authModal");
const authForm = document.getElementById("authForm");
const authMessage = document.getElementById("authMessage");
const authName = document.getElementById("authName");
const authTitle = document.getElementById("authTitle");
const authSubmit = document.getElementById("authSubmit");
const authNameLabel = document.getElementById("authNameLabel");
const authClient = window.SUPABASE_CONFIG?.url && window.SUPABASE_CONFIG?.anonKey
  ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey)
  : null;

document.getElementById("profileButton").addEventListener("click", async () => {
  if (currentUser) {
    if (authClient) await authClient.auth.signOut();
    currentUser = null;
    updateUserUi(null);
    showToast("You have been signed out");
    return;
  }
  authModal.hidden = false;
  authName.focus();
});
document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => {
  authMode = button.dataset.authMode;
  document.querySelectorAll("[data-auth-mode]").forEach((tab) => tab.classList.toggle("active", tab === button));
  const signingIn = authMode === "signin";
  authTitle.textContent = signingIn ? "Welcome back" : "Join the chase";
  authSubmit.innerHTML = signingIn ? "Sign in <span>→</span>" : "Create account <span>→</span>";
  authName.hidden = signingIn;
  authName.required = !signingIn;
  authNameLabel.hidden = signingIn;
  document.getElementById("authPassword").autocomplete = signingIn ? "current-password" : "new-password";
  authMessage.textContent = signingIn
    ? "Sign in to continue your race."
    : "Your email is private and your name is shown on the leaderboard.";
}));
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const name = authName.value.trim();
  authSubmit.disabled = true;
  authMessage.textContent = "Please wait...";
  try {
    if (authClient) {
      const result = authMode === "signup"
        ? await authClient.auth.signUp({ email, password, options: { data: { display_name: name } } })
        : await authClient.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (authMode === "signup" && !result.data.session) {
        authModal.hidden = true;
        showToast("Check your email to confirm your account");
      } else {
        currentUser = result.data.user;
        updateUserUi(currentUser);
        authModal.hidden = true;
        showToast(`Welcome${name ? `, ${name}` : ""}!`);
      }
    } else {
      const demoName = authMode === "signup" ? name : (localStorage.getItem("mirbooDemoName") || email.split("@")[0]);
      if (authMode === "signup") localStorage.setItem("mirbooDemoName", demoName);
      currentUser = { user_metadata: { display_name: demoName }, email };
      updateUserUi(currentUser);
      authModal.hidden = true;
      showToast("Demo account active — add Supabase credentials to enable real accounts");
    }
  } catch (error) {
    authMessage.textContent = error.message || "Authentication failed. Please try again.";
  } finally {
    authSubmit.disabled = false;
  }
});

if (authClient) {
  authClient.auth.getSession().then(({ data }) => {
    currentUser = data.session?.user || null;
    updateUserUi(currentUser);
  });
}

function updateUserUi(user) {
  const name = user?.user_metadata?.display_name || user?.email?.split("@")[0] || null;
  const profileButton = document.getElementById("profileButton");
  profileButton.firstChild.textContent = `${name || "Sign in"} `;
  document.getElementById("userAvatar").textContent = name ? name.slice(0, 2).toUpperCase() : "JD";
  if (name) localStorage.setItem("mirbooRunnerName", name);
}
