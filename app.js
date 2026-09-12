const providers = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    note: "OpenStreetMap · © OpenStreetMap contributors"
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri",
    note: "Esri World Imagery · Tiles © Esri"
  }
};
const activityStartCutoff = new Date("2026-09-09T00:00:00+10:00");
const avatarColors = ["#f76b45", "#6e59d9", "#3a9d78", "#d49a32", "#2f8f9d", "#bd5b8f", "#6f8f3d", "#b86b35"];

function getUserColor(identifier) {
  let hash = 0;
  for (const character of String(identifier || "user")) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return avatarColors[hash % avatarColors.length];
}

let loadedRoute = null;
let routeDistanceKm = 0;
let challenges = [];
let selectedChallenge = null;
let enrolledChallengeIds = new Set();
// Towns and cities in route order, with approximate distances from the start.
const routeLandmarks = [
  { name: "Morwell", distanceKm: 16.84 },
  { name: "Driffield", distanceKm: 25.1 },
  { name: "Traralgon East", distanceKm: 50.9 },
  { name: "Cowwarr", distanceKm: 75.1 },
  { name: "Maffra", distanceKm: 100 },
  { name: "Nicholson", distanceKm: 175.2 },
  { name: "Orbost", distanceKm: 250.8 },
  { name: "Cabbage Tree Creek", distanceKm: 275.3 },
  { name: "Cann River", distanceKm: 325 },
  { name: "Genoa", distanceKm: 375.1 },
  { name: "Timbillica", distanceKm: 400 },
  { name: "Boydtown", distanceKm: 425.6 },
  { name: "South Pambula", distanceKm: 450 },
  { name: "Wyndham", distanceKm: 475.3 },
  { name: "Coolangubra", distanceKm: 500.1 },
  { name: "Ando", distanceKm: 525.1 },
  { name: "Boco", distanceKm: 550.2 },
  { name: "Dalgety", distanceKm: 575 },
  { name: "Jindabyne", distanceKm: 600 },
  { name: "Penderlea", distanceKm: 625 },
  { name: "Jacobs River", distanceKm: 650.1 },
  { name: "Kosciuszko", distanceKm: 675.1 },
  { name: "Khancoban", distanceKm: 700.1 },
  { name: "Bringenbrong", distanceKm: 725 },
  { name: "Tallangatta", distanceKm: 825.1 },
  { name: "Springhurst", distanceKm: 900.7 },
  { name: "Wangaratta", distanceKm: 925 },
  { name: "Baddaginnie", distanceKm: 978.6 },
  { name: "Violet Town", distanceKm: 1000 },
  { name: "Euroa", distanceKm: 1026.6 },
  { name: "Avenel", distanceKm: 1053.5 },
  { name: "Seymour", distanceKm: 1075 },
  { name: "Wallan", distanceKm: 1125.2 },
  { name: "Melbourne", distanceKm: 1150 },
  { name: "Koo Wee Rup", distanceKm: 1251.2 },
  { name: "Nyora", distanceKm: 1275.1 }
];
const runnerLayer = L.layerGroup();
let runnerPositions = [];
let runnerRouteDistances = [];
let locationMarker = null;
let currentRunnerPosition = null;
const map = L.map("map", { zoomControl: false, scrollWheelZoom: false }).setView([-38.4, 146.16], 13);
L.control.zoom({ position: "bottomright" }).addTo(map);
let activeLayer = L.tileLayer(providers.osm.url, { attribution: providers.osm.attribution, maxZoom: 18 }).addTo(map);
runnerLayer.addTo(map);

async function loadChallengeRoute(challenge) {
  try {
    const response = await fetch(challenge.route_file);
    if (!response.ok) throw new Error(`Could not load ${challenge.route_file} (${response.status})`);
    const kml = new DOMParser().parseFromString(await response.text(), "application/xml");
    const coordinateText = [...kml.querySelectorAll("LineString coordinates")]
      .map((element) => element.textContent)
      .join(" ");
    const route = coordinateText.trim().split(/\s+/).map((point) => {
      const [longitude, latitude] = point.split(",").map(Number);
      return [latitude, longitude];
    }).filter(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude));
    if (route.length < 2) throw new Error(`${challenge.route_file} does not contain a usable LineString route`);

    runnerLayer.clearLayers();
    map.eachLayer((layer) => {
      if (layer instanceof L.Polyline && layer !== activeLayer && layer !== runnerLayer) map.removeLayer(layer);
    });
    const routeLine = L.polyline(route, { color: "#f76b45", weight: 5, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });
    loadedRoute = route;
    await addRunnerMarkers(route);
    renderChallengeDetails();
    mapNote.textContent = `Route loaded from ${challenge.route_file}`;
  } catch (error) {
    console.error(error);
    showToast(`Could not load ${challenge.route_file}. Run the site through a local web server.`);
  }
}

async function addRunnerMarkers(route) {
  const segmentDistances = route.slice(1).map((point, index) => map.distance(route[index], point) / 1000);
  const totalDistance = segmentDistances.reduce((sum, distance) => sum + distance, 0);
  routeDistanceKm = totalDistance;
  routeLandmarks.forEach((landmark) => {
    landmark.distanceKm = Math.min(landmark.distanceKm, totalDistance);
  });
  const cumulativeDistances = [0];
  segmentDistances.forEach((distance) => cumulativeDistances.push(cumulativeDistances.at(-1) + distance));
  const runners = await loadRealRunners();
  runnerLayer.clearLayers();
  runnerPositions = [];
  runnerRouteDistances = [];
  currentRunnerPosition = null;

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
    runnerPositions.push(position);
    runnerRouteDistances.push(distanceAlongRoute);
    if (currentUser && runner.id === currentUser.id) currentRunnerPosition = position;
    const displayName = formatRunnerName(runner.name);
    const initials = getInitials(displayName);
    const icon = L.divIcon({
      className: "runner-marker",
      html: `<span style="background:${runner.color}">${initials}</span>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
    L.marker(position, { icon })
      .addTo(runnerLayer)
      .bindTooltip(`${displayName} · ${runner.distanceKm} km`, {
        direction: "top",
        offset: [0, -14],
        permanent: true,
        className: "runner-tooltip"
      });
  });
}

document.getElementById("routeButton").addEventListener("click", () => {
  if (!loadedRoute) {
    showToast("The route is still loading");
    return;
  }
  map.fitBounds(L.latLngBounds(loadedRoute), { padding: [20, 20] });
});

document.getElementById("fieldButton").addEventListener("click", () => {
  if (runnerPositions.length === 0) {
    showToast("No runners have joined yet");
    return;
  }
  const sorted = runnerPositions
    .map((position, index) => ({ position, distance: runnerRouteDistances[index] }))
    .sort((a, b) => a.distance - b.distance);
  const start = Math.floor((sorted.length - 1) * 0.1);
  const end = Math.ceil((sorted.length - 1) * 0.9);
  map.fitBounds(L.latLngBounds(sorted.slice(start, end + 1).map((runner) => runner.position)), { padding: [55, 55] });
});

document.getElementById("locateButton").addEventListener("click", () => {
  if (!currentUser) {
    showToast("Sign in to see your position on the route");
    return;
  }
  if (!currentRunnerPosition) {
    showToast("Join the race to see your route position");
    return;
  }
  map.setView(currentRunnerPosition, 15);
  if (locationMarker) map.removeLayer(locationMarker);
  locationMarker = L.circleMarker(currentRunnerPosition, {
    radius: 9,
    color: "#fff",
    weight: 3,
    fillColor: getUserColor(currentUser.id || currentUser.email),
    fillOpacity: 1
  }).addTo(map).bindTooltip(`${currentUser.user_metadata?.display_name || "Your"} · current race position`).openTooltip();
});

async function loadRealRunners() {
  if (!authClient || !selectedChallenge) {
    renderRunnerData([]);
    return [];
  }
  const [profilesResult, entriesResult] = await Promise.all([
    authClient.from("profiles").select("id, display_name"),
    authClient.from("challenge_entries").select("user_id, distance_km").eq("challenge_id", selectedChallenge.id)
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (entriesResult.error) throw entriesResult.error;
  const distances = new Map(entriesResult.data.map((entry) => [entry.user_id, Number(entry.distance_km) || 0]));
  const runners = profilesResult.data.filter((profile) => distances.has(profile.id)).map((profile) => ({
    id: profile.id,
    name: profile.display_name,
    distanceKm: distances.get(profile.id) || 0,
    color: getUserColor(profile.id)
  })).sort((a, b) => b.distanceKm - a.distanceKm);
  renderRunnerData(runners);
  await updateEstimatedArrival(runners);
  await loadRecentRuns();
  return runners;
}

async function loadRecentRuns() {
  const list = document.getElementById("recentRunsList");
  if (!authClient) {
    list.innerHTML = '<p class="empty-state">Sign in to load recent runs.</p>';
    return;
  }
  const { data, error } = await authClient
    .from("activities")
    .select("distance_km, started_at, file_type, profiles(id, display_name)")
    .eq("challenge_id", selectedChallenge.id)
    .order("started_at", { ascending: false })
    .limit(10);
  if (error) {
    list.innerHTML = '<p class="empty-state">Run the activity migration to enable the latest-runs log.</p>';
    return;
  }
  list.innerHTML = data.length ? data.map((activity) => {
    const name = formatRunnerName(activity.profiles?.display_name || "Runner");
    const initials = getInitials(name);
    const color = getUserColor(activity.profiles?.id || name);
    const date = new Date(activity.started_at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
    const source = activity.file_type === "manual" ? "Manual entry" : activity.file_type.toUpperCase();
    return `<div class="recent-run">
      <span class="recent-run-avatar" style="background:${color}">${initials}</span>
      <div class="recent-run-details"><strong>${escapeHtml(name)}</strong><small>${date} · ${source}</small></div>
      <strong class="recent-run-distance">${Number(activity.distance_km).toFixed(2)} <small>km</small></strong>
    </div>`;
  }).join("") : '<p class="empty-state">No runs have been uploaded yet.</p>';
}

function renderRunnerData(runners) {
  const totalDistance = runners.reduce((sum, runner) => sum + runner.distanceKm, 0);
  document.getElementById("runnerCount").textContent = runners.length;
  document.getElementById("runnerLabel").textContent = runners.length === 1 ? "Runner" : "Runners";
  document.getElementById("totalDistance").textContent = Math.round(totalDistance);
  document.getElementById("eventDistance").textContent = `${Math.round(totalDistance)} km complete`;
  document.getElementById("eventPercent").textContent = `${Math.min(100, Math.round(totalDistance / Math.max(routeDistanceKm, 1) * 100))}%`;
  document.querySelector(".event-progress span").style.width = `${Math.min(100, totalDistance / Math.max(routeDistanceKm, 1) * 100)}%`;
  const rows = document.getElementById("leaderboardRows");
  rows.innerHTML = runners.length ? runners.slice(0, 5).map((runner, index) => `
    <div class="leader-row">
      <span class="rank ${index === 0 ? "first" : ""}">${String(index + 1).padStart(2, "0")}</span>
      <span class="mini-avatar" style="background:${runner.color}">${getInitials(runner.name)}</span>
      <div class="runner-name"><strong>${escapeHtml(formatRunnerName(runner.name))}</strong><small>${runner.distanceKm} km along route</small></div>
      <strong class="distance">${runner.distanceKm} <small>km</small></strong>
    </div>`).join("") : '<p class="empty-state">No runners have joined yet.</p>';
  updatePersonalProgress(runners);
}

async function updateEstimatedArrival(runners) {
  const output = document.getElementById("estimatedArrival");
  const daysOutput = document.getElementById("daysRemaining");
  if (!currentUser || !selectedChallenge || !authClient) {
    output.textContent = "--";
    daysOutput.textContent = "--";
    return;
  }
  const runner = runners.find((entry) => entry.id === currentUser.id);
  if (!runner || runner.distanceKm >= routeDistanceKm) {
    output.textContent = runner ? "Arrived" : "--";
    daysOutput.textContent = runner ? "0" : "--";
    return;
  }
  const { data, error } = await authClient
    .from("activities")
    .select("distance_km, started_at")
    .eq("challenge_id", selectedChallenge.id)
    .eq("user_id", currentUser.id)
    .order("started_at", { ascending: true });
  if (error) throw error;
  if (!data?.length) {
    output.textContent = "--";
    daysOutput.textContent = "--";
    return;
  }
  const firstRun = new Date(data[0].started_at);
  const elapsedDays = Math.max(1, Math.ceil((Date.now() - firstRun.getTime()) / 86400000) + 1);
  const averageDailyKm = runner.distanceKm / elapsedDays;
  if (!Number.isFinite(averageDailyKm) || averageDailyKm <= 0) {
    output.textContent = "--";
    daysOutput.textContent = "--";
    return;
  }
  const remainingDays = Math.ceil((routeDistanceKm - runner.distanceKm) / averageDailyKm);
  const arrivalDate = new Date(Date.now() + remainingDays * 86400000);
  daysOutput.textContent = String(remainingDays);
  output.textContent = arrivalDate.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function updatePersonalProgress(runners) {
  const currentName = currentUser?.user_metadata?.display_name;
  const currentRunner = runners.find((runner) => runner.name === currentName);
  const distance = currentRunner?.distanceKm || 0;
  document.getElementById("progressTitle").textContent = currentName
    ? `${currentName}, keep going!`
    : "Sign in to track your progress";
  document.getElementById("personalDistance").textContent = distance;
  document.getElementById("personalProgressBar").style.width = `${Math.min(100, distance / Math.max(routeDistanceKm, 1) * 100)}%`;
  document.getElementById("nextLandmark").innerHTML = `${getNextTown(distance, Boolean(currentName))} <span>›</span>`;
}

function formatRunnerName(name) {
  if (currentUser) return name;
  return name.trim().split(/\s+/)[0] || "Runner";
}

function getInitials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function getNextTown(distanceKm, isSignedIn) {
  if (!isSignedIn) return "Sign in to see your next town";
  const nextLandmark = routeLandmarks
    .filter((landmark) => landmark.distanceKm >= distanceKm - 0.25)
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  return nextLandmark?.name || "Route finish";
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

let selectedChallengeEnrolled = false;

function renderChallengeDetails() {
  if (!selectedChallenge) return;
  document.getElementById("sidebarChallengeName").innerHTML = escapeHtml(selectedChallenge.name).replace(/\s+/g, "<br />");
  document.getElementById("heroChallengeName").innerHTML = `${escapeHtml(selectedChallenge.name)} <span>✦</span>`;
  document.getElementById("challengeName").textContent = selectedChallenge.name;
  document.getElementById("challengeMeta").textContent =
    `${new Date(`${selectedChallenge.start_date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · ${selectedChallenge.start_location} to ${selectedChallenge.finish_location}`;
  document.getElementById("challengeJoinButton").textContent = selectedChallengeEnrolled ? "Enrolled" : "Join challenge";
  document.getElementById("challengeJoinButton").disabled = selectedChallengeEnrolled;
  document.querySelector(".activity-panel .progress-number small").textContent =
    `of ${Math.round(routeDistanceKm || 1336).toLocaleString()} km total`;
  document.getElementById("activityEntryGrid").hidden = !(currentUser && selectedChallengeEnrolled);
}

async function loadChallenges() {
  const fallbackChallenge = {
    id: "local-default",
    name: "Race around Australia",
    route_file: "route.kml",
    start_date: "2026-09-09",
    start_location: "Mirboo North",
    finish_location: "South Point"
  };
  if (!authClient) {
    challenges = [fallbackChallenge];
    selectedChallenge = fallbackChallenge;
    renderChallengeSelector();
    renderChallengeDetails();
    await loadChallengeRoute(selectedChallenge);
    return;
  }
  const { data, error } = await authClient
    .from("challenges")
    .select("id, name, route_file, start_date, start_location, finish_location")
    .order("start_date", { ascending: true });
  if (error) throw error;
  challenges = data || [];
  if (!challenges.length) {
    selectedChallenge = null;
    document.getElementById("challengeName").textContent = "No challenges available";
    document.getElementById("challengeMeta").textContent = "Run the challenges migration in Supabase.";
    return;
  }
  selectedChallenge = challenges.find((challenge) => challenge.id === selectedChallenge?.id) || challenges[0];
  await refreshChallengeEnrollment();
  renderChallengeSelector();
  renderChallengeDetails();
  await loadChallengeRoute(selectedChallenge);
}

async function refreshChallengeEnrollment() {
  if (!currentUser || !selectedChallenge || !authClient || selectedChallenge.id === "local-default") {
    enrolledChallengeIds = new Set();
    selectedChallengeEnrolled = false;
    return;
  }
  const { data, error } = await authClient
    .from("challenge_entries")
    .select("id, challenge_id")
    .eq("user_id", currentUser.id)
    .limit(1000);
  if (error) throw error;
  enrolledChallengeIds = new Set((data || []).map((entry) => entry.challenge_id));
  selectedChallengeEnrolled = enrolledChallengeIds.has(selectedChallenge.id);
}

function renderChallengeSelector() {
  const select = document.getElementById("challengeSelect");
  select.innerHTML = challenges.map((challenge) =>
    `<option value="${escapeHtml(challenge.id)}">${escapeHtml(challenge.name)}${enrolledChallengeIds.has(challenge.id) ? " (Enrolled)" : ""}</option>`
  ).join("");
  if (selectedChallenge) select.value = selectedChallenge.id;
}

document.getElementById("challengeSelect").addEventListener("change", async (event) => {
  selectedChallenge = challenges.find((challenge) => challenge.id === event.target.value);
  if (!selectedChallenge) return;
  await refreshChallengeEnrollment();
  renderChallengeDetails();
  await loadChallengeRoute(selectedChallenge);
});

document.getElementById("challengeJoinButton").addEventListener("click", () => {
  document.getElementById("joinButton").click();
});

const mapSelect = document.getElementById("mapProvider");
const mapNote = document.getElementById("mapNote");
mapSelect.addEventListener("change", (event) => {
  const provider = event.target.value;
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
  if (!selectedChallenge || selectedChallenge.id === "local-default") {
    showToast("Run the challenges migration before joining");
    return;
  }
  const { error } = await authClient.from("challenge_entries").upsert(
    { user_id: currentUser.id, challenge_id: selectedChallenge.id, distance_km: 0 },
    { onConflict: "challenge_id,user_id" }
  );
  if (error) {
    showToast(error.message);
    return;
  }
  selectedChallengeEnrolled = true;
  enrolledChallengeIds.add(selectedChallenge.id);
  renderChallengeSelector();
  renderChallengeDetails();
  showToast("You joined the race");
  if (loadedRoute) await addRunnerMarkers(loadedRoute);
});
// The connected-watch sidebar section is currently commented out in index.html.
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

document.getElementById("activityFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const uploadMessage = document.getElementById("uploadMessage");
  event.target.value = "";
  if (!file) return;
  if (!currentUser || !authClient || !selectedChallengeEnrolled) {
    uploadMessage.textContent = "Join the selected challenge before uploading a run.";
    showToast("Join this challenge to upload a run");
    return;
  }
  uploadMessage.textContent = "Reading your activity...";
  try {
    const extension = file.name.toLowerCase().split(".").pop();
    const activity = extension === "gpx"
      ? await parseGpxDistance(file)
      : extension === "fit"
        ? await parseFitDistance(file)
        : 0;
    if (!activity.distanceKm || !Number.isFinite(activity.distanceKm)) throw new Error("No distance could be found in that file");
    if (!activity.startedAt || activity.startedAt < activityStartCutoff) {
      throw new Error("This activity started before 9 September 2026 and cannot be accepted.");
    }
    const { error } = await authClient.rpc("add_activity_distance", {
      p_file_name: file.name,
      p_file_type: extension,
      p_distance_km: Number(activity.distanceKm.toFixed(2)),
      p_started_at: activity.startedAt.toISOString(),
      p_challenge_id: selectedChallenge?.id
    });

    if (error) throw error;
    uploadMessage.textContent = `${activity.distanceKm.toFixed(2)} km added from ${file.name}`;
    showToast(`${activity.distanceKm.toFixed(2)} km added to your race total`);
    if (loadedRoute) await addRunnerMarkers(loadedRoute);
  } catch (error) {
    uploadMessage.textContent = error.message || "This activity could not be uploaded.";
    showToast("Activity upload failed");
  }
});

document.getElementById("manualRunForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("manualMessage");
  const distanceKm = Number(document.getElementById("manualDistance").value);
  const dateValue = document.getElementById("manualDate").value;
  const startedAt = dateValue ? new Date(`${dateValue}T00:00:00+10:00`) : null;
  if (!currentUser || !authClient || !selectedChallengeEnrolled) {
    message.textContent = "Join the selected challenge before adding a run.";
    showToast("Join this challenge to add a run");
    return;
  }
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 1000 || Number((distanceKm * 100).toFixed(5)) % 1 !== 0) {
    message.textContent = "Enter a distance between 0.01 and 1000 km, with up to 2 decimal places.";
    return;
  }
  if (!startedAt || Number.isNaN(startedAt.getTime()) || startedAt < activityStartCutoff) {
    message.textContent = "Runs dated before 9 September 2026 are not accepted.";
    return;
  }
  const submitButton = form.querySelector("button");
  submitButton.disabled = true;
  message.textContent = "Adding your run...";
  try {
    const { error } = await authClient.rpc("add_activity_distance", {
      p_file_name: "Manual entry",
      p_file_type: "manual",
      p_distance_km: Number(distanceKm.toFixed(2)),
      p_started_at: startedAt.toISOString(),
      p_challenge_id: selectedChallenge?.id
    });
    if (error) throw error;
    message.textContent = `${distanceKm.toFixed(2)} km added`;
    showToast(`${distanceKm.toFixed(2)} km added to your race total`);
    form.reset();
    if (loadedRoute) await addRunnerMarkers(loadedRoute);
  } catch (error) {
    message.textContent = error.message || "This run could not be added.";
    showToast("Manual run could not be added");
  } finally {
    submitButton.disabled = false;
  }
});

async function parseGpxDistance(file) {
  const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("The GPX file is not valid XML");
  const points = [...xml.querySelectorAll("trkpt, rtept")].map((point) => ({
    position: [Number(point.getAttribute("lat")), Number(point.getAttribute("lon"))],
    startedAt: point.querySelector("time")?.textContent
      ? new Date(point.querySelector("time").textContent)
      : null
  })).filter((point) => Number.isFinite(point.position[0]) && Number.isFinite(point.position[1]));
  if (points.length < 2) throw new Error("The GPX file does not contain enough track points");
  const startedAt = points.map((point) => point.startedAt).find(Boolean);
  if (!startedAt || Number.isNaN(startedAt.getTime())) throw new Error("The GPX file does not contain a valid activity date");
  return {
    distanceKm: points.slice(1).reduce((distance, point, index) => distance + map.distance(points[index].position, point.position) / 1000, 0),
    startedAt
  };
}

async function parseFitDistance(file) {
  let FitParser;
  try {
    ({ default: FitParser } = await import("https://esm.sh/fit-file-parser@5.0.2"));
  } catch {
    throw new Error("FIT support could not be loaded. Try a GPX export instead.");
  }
  const parser = new FitParser({ mode: "list", lengthUnit: "km" });
  const data = await parser.parseAsync(await file.arrayBuffer());
  const session = data.sessions?.[0];
  const distanceKm = Number(session?.total_distance);
  const startedAt = session?.start_time ? new Date(session.start_time) : null;
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new Error("The FIT file does not contain a total distance");
  }
  if (!startedAt || Number.isNaN(startedAt.getTime())) throw new Error("The FIT file does not contain a valid activity date");
  return { distanceKm, startedAt };
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}

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

const profileButton = document.getElementById("profileButton");
const profileDropdown = document.getElementById("profileDropdown");
profileButton.addEventListener("click", () => {
  if (!currentUser) {
    authModal.hidden = false;
    authName.focus();
    return;
  }
  profileDropdown.hidden = !profileDropdown.hidden;
  profileButton.setAttribute("aria-expanded", String(!profileDropdown.hidden));
});
document.getElementById("signOutButton").addEventListener("click", async () => {
  if (authClient) await authClient.auth.signOut();
  currentUser = null;
  currentRunnerPosition = null;
  profileDropdown.hidden = true;
  profileButton.setAttribute("aria-expanded", "false");
  if (locationMarker) {
    map.removeLayer(locationMarker);
    locationMarker = null;
  }
  updateUserUi(null);
  enrolledChallengeIds = new Set();
  selectedChallengeEnrolled = false;
  renderChallengeDetails();
  if (loadedRoute) await addRunnerMarkers(loadedRoute);
  showToast("You have been signed out");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".profile-menu")) {
    profileDropdown.hidden = true;
    profileButton.setAttribute("aria-expanded", "false");
  }
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
        await refreshChallengeEnrollment();
        renderChallengeDetails();
        if (loadedRoute) await addRunnerMarkers(loadedRoute);
        authModal.hidden = true;
        showToast(`Welcome${name ? `, ${name}` : ""}!`);
      }
    } else {
      const demoName = authMode === "signup" ? name : (localStorage.getItem("mirbooDemoName") || email.split("@")[0]);
      if (authMode === "signup") localStorage.setItem("mirbooDemoName", demoName);
      currentUser = { user_metadata: { display_name: demoName }, email };
      updateUserUi(currentUser);
      renderChallengeDetails();
      authModal.hidden = true;
      showToast("Demo account active — add Supabase credentials to enable real accounts");
    }
  } catch (error) {
    authMessage.textContent = error.message || "Authentication failed. Please try again.";
  } finally {
    authSubmit.disabled = false;
  }
});

async function initializeChallenges() {
  try {
    if (authClient) {
      const { data } = await authClient.auth.getSession();
      currentUser = data.session?.user || null;
      updateUserUi(currentUser);
    }
    await loadChallenges();
  } catch (error) {
    console.error(error);
    showToast("Could not load challenges");
  }
}

initializeChallenges();

function updateUserUi(user) {
  const name = user?.user_metadata?.display_name || user?.email?.split("@")[0] || null;
  const profileButton = document.getElementById("profileButton");
  profileButton.firstChild.textContent = `${name || "Sign in"} `;
  const userAvatar = document.getElementById("userAvatar");
  userAvatar.textContent = name ? getInitials(name) : "";
  userAvatar.style.background = name ? getUserColor(user.id || name) : "";
  document.getElementById("activityEntryGrid").hidden = !(user && selectedChallengeEnrolled);
  if (name) localStorage.setItem("mirbooRunnerName", name);
}
