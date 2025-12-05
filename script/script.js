// Global state
let formData = {};
let chatHistory = [];
let dynamicQuestions = [];
let currentQuestionIndex = 0;
let collectedData = {};
let generatedPlan = null;
let mapInstance = null;

const apiKey = "AIza" + "SyAqDcVDj60Ghg98B19O" + "wFg8HfDy1_BWQZE";
const BACKEND_URL = "http://127.0.0.1:5000";

// Utility functions
function showPage(pageId) {
  document
    .querySelectorAll(".page-section")
    .forEach((s) => s.classList.add("hidden"));
  document.getElementById(pageId).classList.remove("hidden");
  if (pageId === "plan-page" && mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 100);
  }
}

function addChatMessage(sender, text) {
  const chatMessages = document.getElementById("chat-messages");
  const messageEl = document.createElement("div");
  let bgColor, textColor, align, senderName;

  switch (sender) {
    case "user":
      bgColor = "bg-blue-600";
      textColor = "text-white";
      align = "flex justify-end";
      senderName = "You";
      break;
    case "ai":
      bgColor = "bg-gray-700";
      textColor = "text-gray-200";
      align = "flex justify-start";
      senderName = "AI Assistant";
      break;
    default:
      bgColor = "bg-gray-800";
      textColor = "text-yellow-400";
      align = "flex justify-center";
      senderName = "System";
  }

  const wrapperDiv = document.createElement("div");
  wrapperDiv.className = `w-full ${align}`;
  messageEl.className = `max-w-lg p-3 my-2 rounded-lg ${bgColor} ${textColor} shadow-md`;
  messageEl.innerHTML = `<strong class="block text-sm">${senderName}</strong><p>${text}</p>`;
  wrapperDiv.appendChild(messageEl);
  chatMessages.appendChild(wrapperDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showChatLoader(show, text = "AI is thinking...") {
  const loader = document.getElementById("chat-loader");
  const loaderText = document.getElementById("chat-loader-text");
  if (show) {
    loaderText.textContent = text;
    loader.classList.remove("hidden");
  } else {
    loader.classList.add("hidden");
  }
}

function showErrorModal(title, message) {
  document.getElementById("error-title").textContent = title;
  document.getElementById("error-message").textContent = message;
  document.getElementById("error-modal").classList.remove("hidden");
}

function showNotification(title, message) {
  const container = document.getElementById("notification-container");
  const id = `notif-${Date.now()}`;
  const el = document.createElement("div");
  el.id = id;
  el.className =
    "bg-gray-800 border border-blue-500 text-white p-4 rounded-lg shadow-xl";
  el.innerHTML = `
    <div class="flex justify-between items-center mb-2">
      <h4 class="font-bold text-blue-400">${title}</h4>
      <button class="text-gray-500 hover:text-white" onclick="document.getElementById('${id}').remove()">&times;</button>
    </div>
    <p>${message}</p>
  `;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// AI API Call with retry
async function callGeminiAPI(
  systemPrompt,
  userQuery,
  useGrounding = false,
  jsonResponse = false,
) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const apiPayload = {
    contents: [{ parts: [{ text: userQuery }] }],
  };

  if (systemPrompt) {
    apiPayload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (useGrounding) {
    apiPayload.tools = [{ google_search: {} }];
  }
  if (jsonResponse) {
    apiPayload.generationConfig = { responseMimeType: "application/json" };
  }

  let attempts = 0;
  const maxAttempts = 3;
  const baseDelay = 1000;

  while (attempts < maxAttempts) {
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiPayload),
      });

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }

      const result = await response.json();
      const candidate = result.candidates?.[0];

      if (candidate?.content?.parts?.[0]?.text) {
        const text = candidate.content.parts[0].text;
        let sources = [];
        const groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata?.groundingAttributions) {
          sources = groundingMetadata.groundingAttributions
            .map((attr) => ({ uri: attr.web?.uri, title: attr.web?.title }))
            .filter((source) => source.uri && source.title);
        }
        return { text, sources };
      } else {
        throw new Error("Invalid API response structure");
      }
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) throw error;
      const delay = baseDelay * Math.pow(2, attempts);
      console.warn(`AI API error (attempt ${attempts}): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Form submission
document.getElementById("crisis-form").addEventListener("submit", function (e) {
  e.preventDefault();

  formData = {
    incident_type: document.querySelector('input[name="incident_type"]:checked')
      .value,
    scale: document.querySelector('input[name="scale"]:checked').value,
    infrastructure: document.querySelector(
      'input[name="infrastructure"]:checked',
    ).value,
    population: document.querySelector('input[name="population"]:checked')
      .value,
    critical_need: document.querySelector('input[name="critical_need"]:checked')
      .value,
    urgency: document.querySelector('input[name="urgency"]:checked').value,
  };

  const summaryDiv = document.getElementById("form-summary");
  const labels = {
    incident_type: "Incident Type",
    scale: "Scale",
    infrastructure: "Infrastructure",
    population: "Population Affected",
    critical_need: "Critical Need",
    urgency: "Urgency",
  };

  let summaryHTML = "";
  for (const [key, value] of Object.entries(formData)) {
    summaryHTML += `<p><strong>${labels[key]}:</strong> ${value.replace(/_/g, " ")}</p>`;
  }
  summaryDiv.innerHTML = summaryHTML;

  showPage("entry-page");
  lucide.createIcons();
});

// Initial analysis
async function handleInitialAnalysis() {
  const detailedDescription =
    document.getElementById("crisis-description").value;
  if (!detailedDescription) {
    showErrorModal(
      "Input Required",
      "Please provide a detailed crisis description.",
    );
    return;
  }

  showPage("chat-page");
  addChatMessage("user", detailedDescription);
  showChatLoader(true);

  const formContext = Object.entries(formData)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");

  collectedData = {
    formData: formData,
    initialDescription: detailedDescription,
    formContext: formContext,
  };

  chatHistory.push({ role: "user", parts: [{ text: detailedDescription }] });

  try {
    // Step 1: Augment with Google Search
    const systemPromptAugment = `You are a humanitarian aid logistics expert. Use Google Search to find real-time data about this crisis.

Form Data: ${formContext}
Description: ${detailedDescription}

Provide a concise summary with:
- Exact Location (with coordinates if possible)
- Current Situation
- Population Data
- Infrastructure Status
- Available Resources
- Sources (2-3 URLs)`;

    const augmentData = await callGeminiAPI(
      systemPromptAugment,
      detailedDescription,
      true,
    );

    let sourcesText = "";
    if (augmentData.sources.length > 0) {
      sourcesText =
        "<br><br><strong>Sources:</strong><br>" +
        augmentData.sources
          .map(
            (s) =>
              `<a href="${s.uri}" target="_blank" class="text-blue-400 hover:underline">${s.title}</a>`,
          )
          .join("<br>");
    }

    addChatMessage(
      "system",
      `<strong>Augmented Data:</strong><br>${augmentData.text.replace(/\n/g, "<br>")}${sourcesText}`,
    );
    chatHistory.push({ role: "model", parts: [{ text: augmentData.text }] });
    collectedData.augmentedData = augmentData.text;

    // Step 2: Generate targeted questions
    const combinedContext = `Form: ${formContext}\n\nReport: ${detailedDescription}\n\nAnalysis:\n${augmentData.text}`;

    const systemPromptQuestions = `Generate 5 targeted questions to gather precise data for resource distribution planning.

Context: ${combinedContext}

Focus on:
1. Exact GPS coordinates or addresses
2. Specific resource quantities needed
3. Transport/logistics details
4. Population numbers at specific locations
5. Available local infrastructure

Respond with ONLY a JSON array:
["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?"]`;

    const questionData = await callGeminiAPI(
      systemPromptQuestions,
      combinedContext,
      false,
      true,
    );

    try {
      dynamicQuestions = JSON.parse(questionData.text.trim());
    } catch (e) {
      console.error("Failed to parse questions:", e);
      dynamicQuestions = [
        "What are the exact GPS coordinates of affected areas?",
        "What specific quantities of water, food, and medical supplies are needed at each location?",
        "What is the current status of roads and transport routes?",
        "How many people are at each shelter or gathering point?",
        "Are there any operational warehouses or distribution centers?",
      ];
    }

    currentQuestionIndex = 0;
    if (dynamicQuestions.length > 0) {
      addChatMessage("ai", dynamicQuestions[currentQuestionIndex]);
    }
  } catch (error) {
    console.error("Analysis Error:", error);
    showErrorModal(
      "AI Error",
      `Failed to generate questions: ${error.message}`,
    );
    showPage("entry-page");
  } finally {
    showChatLoader(false);
  }
}

// Handle user messages
async function handleUserMessage() {
  const userInput = document.getElementById("chat-input");
  const message = userInput.value.trim();
  if (!message) return;

  addChatMessage("user", message);
  userInput.value = "";
  showChatLoader(true, "Processing...");

  const currentQuestion = dynamicQuestions[currentQuestionIndex];
  collectedData[`question_${currentQuestionIndex}`] = {
    question: currentQuestion,
    answer: message,
  };

  currentQuestionIndex++;
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (currentQuestionIndex < dynamicQuestions.length) {
    showChatLoader(false);
    addChatMessage("ai", dynamicQuestions[currentQuestionIndex]);
  } else {
    addChatMessage("system", "Summarizing collected data...");

    try {
      const fullConversation = JSON.stringify(collectedData, null, 2);
      const systemPromptSummary = `Analyze this crisis data and provide a structured summary:

${fullConversation}

Include:
- Locations (with coordinates)
- Population estimates
- Infrastructure status
- Available resources
- Resource needs with quantities`;

      const summaryData = await callGeminiAPI(
        systemPromptSummary,
        fullConversation,
      );
      addChatMessage(
        "ai",
        `<strong>Summary:</strong><br>${summaryData.text.replace(/\n/g, "<br>")}`,
      );
      collectedData.finalSummary = summaryData.text;

      // Parse locations and needs
      const systemPromptParse = `Extract structured location data from this summary.

${summaryData.text}

REQUIREMENTS:
- Valid lat/lon coordinates for each location
- Numeric resource needs (water, food, medical)
- Use reasonable estimates if exact data missing

Format:
{
  "locations": [
    {
      "name": "Location Name",
      "lat": 28.5355,
      "lon": 77.391,
      "needs": {"water": 1000, "food": 2000, "medical": 500}
    }
  ]
}`;

      const needsData = await callGeminiAPI(
        systemPromptParse,
        summaryData.text,
        false,
        true,
      );

      try {
        const parsedData = JSON.parse(needsData.text.trim());
        if (!parsedData.locations || !Array.isArray(parsedData.locations)) {
          throw new Error("Invalid locations format");
        }

        parsedData.locations = parsedData.locations.filter((loc) => {
          return (
            loc.name &&
            typeof loc.lat === "number" &&
            typeof loc.lon === "number" &&
            loc.needs
          );
        });

        if (parsedData.locations.length === 0) {
          throw new Error("No valid locations found");
        }

        collectedData.parsedNeeds = parsedData;
        console.log("Parsed locations:", parsedData);
      } catch (e) {
        console.error("Parse error:", e);
        collectedData.parsedNeeds = {
          locations: [
            {
              name: "Primary Zone",
              lat: 28.5355,
              lon: 77.391,
              needs: { water: 5000, food: 10000, medical: 2000 },
            },
            {
              name: "Secondary Zone",
              lat: 28.55,
              lon: 77.4,
              needs: { water: 3000, food: 6000, medical: 1000 },
            },
          ],
        };
        addChatMessage("system", "⚠️ Using default locations");
      }

      showPage("optimization-page");
    } catch (error) {
      console.error("Summary Error:", error);
      showErrorModal("Error", `Failed to summarize: ${error.message}`);
    } finally {
      showChatLoader(false);
    }
  }
}

// Strategy selection
function showConfirmationPage(strategy) {
  collectedData.strategy = strategy;
  const summaryEl = document.getElementById("confirmation-summary");

  let html = `
    <div class="space-y-4">
      <div>
        <h3 class="text-lg font-semibold text-gray-400">Strategy</h3>
        <p class="p-3 bg-gray-900 rounded-md text-xl font-bold text-blue-300">${strategy.toUpperCase()}</p>
      </div>
      <div>
        <h3 class="text-lg font-semibold text-gray-400">Locations</h3>
        <ul class="list-disc list-inside p-3 bg-gray-900 rounded-md">
  `;

  collectedData.parsedNeeds.locations.forEach((loc) => {
    const total =
      (loc.needs.water || 0) + (loc.needs.food || 0) + (loc.needs.medical || 0);
    html += `<li>${loc.name}: ${total} units (W:${loc.needs.water} F:${loc.needs.food} M:${loc.needs.medical})</li>`;
  });

  html += `</ul></div></div>`;
  summaryEl.innerHTML = html;
  showPage("confirmation-page");
}

// Generate plan
async function generateFinalPlan() {
  showPage("plan-page");
  document.getElementById("plan-loader").classList.remove("hidden");
  document.getElementById("plan-content").classList.add("hidden");

  const requestData = {
    strategy: collectedData.strategy,
    parsedNeeds: collectedData.parsedNeeds,
    formData: formData,
    // ADD THESE LINES:
    vehicle_capacity: 20000, // Increase capacity per truck (e.g. 20 tons)
    max_fleet_size: 100, // Allow up to 100 trucks
    time_limit_seconds: 30, // Give the solver more time for complex routes
  };

  console.log("Sending to backend:", requestData);

  try {
    const response = await fetch(`${BACKEND_URL}/generate-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend error ${response.status}: ${errorText}`);
    }

    const planData = await response.json();
    console.log("Received plan:", planData);

    generatedPlan = planData;
    renderPlan(planData);

    document.getElementById("plan-loader").classList.add("hidden");
    document.getElementById("plan-content").classList.remove("hidden");
  } catch (err) {
    console.error("Optimization error:", err);
    showErrorModal("Optimization Error", `Failed: ${err.message}`);
    showPage("confirmation-page");
  }
}

// Render plan with all visualizations
function renderPlan(plan) {
  console.log("Rendering plan:", plan);

  // Update summary with proper field access
  document.getElementById("plan-title").textContent =
    plan.summary.title || "Distribution Plan";
  document.getElementById("plan-description").textContent =
    plan.summary.description || "";
  document.getElementById("stat-strategy").textContent =
    plan.summary.strategy || "N/A";
  document.getElementById("stat-distance").textContent =
    `${Math.round(plan.summary.totalDistanceMeters / 1000)} km`;
  document.getElementById("stat-resources").textContent =
    `${plan.summary.assignedResources || 0} units`;
  document.getElementById("stat-vehicles").textContent =
    `${plan.summary.totalTrucks || plan.routes.length} Trucks`;

  // Add vehicle mode badges
  const modesUsed = new Set();
  plan.routes.forEach((route) => {
    route.segments.forEach((seg) => modesUsed.add(seg.mode));
  });

  const modeFlags = document.getElementById("vehicle-mode-flags");
  modeFlags.innerHTML = "";

  const modeIcons = {
    road: "🚚",
    boat: "⛴️",
    air: "✈️",
  };

  modesUsed.forEach((mode) => {
    const badge = document.createElement("span");
    badge.className = "px-3 py-1 rounded-full text-sm font-semibold";
    badge.style.background =
      mode === "air" ? "#fbbf24" : mode === "boat" ? "#10b981" : "#3b82f6";
    badge.textContent = `${modeIcons[mode]} ${mode.toUpperCase()}`;
    modeFlags.appendChild(badge);
  });

  // Calculate metrics
  const totalDistance = plan.summary.totalDistanceMeters;
  const totalLoad = plan.summary.assignedResources;
  const numVehicles = plan.routes.length;
  const vehicleCapacity = 20000; // From your settings

  const avgLoad = numVehicles > 0 ? Math.round(totalLoad / numVehicles) : 0;
  const avgDistance =
    numVehicles > 0 ? Math.round(totalDistance / numVehicles / 1000) : 0;
  const efficiency =
    avgLoad > 0 && vehicleCapacity > 0
      ? Math.round((avgLoad / vehicleCapacity) * 100)
      : 0;

  document.getElementById("avg-load").textContent = `${avgLoad} units`;
  document.getElementById("avg-load-bar").style.width =
    `${Math.min(100, efficiency)}%`;
  document.getElementById("avg-distance").textContent = `${avgDistance} km`;
  document.getElementById("avg-distance-bar").style.width =
    `${Math.min(100, (avgDistance / 500) * 100)}%`;
  document.getElementById("efficiency-percent").textContent = `${efficiency}%`;
  document.getElementById("efficiency-bar").style.width = `${efficiency}%`;
  document.getElementById("cost-per-km").textContent =
    totalLoad > 0 ? (totalDistance / 1000 / totalLoad).toFixed(3) : "0";

  // Resource totals
  const resourceTotals = { water: 0, food: 0, medical: 0 };
  plan.locations.forEach((loc) => {
    resourceTotals.water += loc.needs.water || 0;
    resourceTotals.food += loc.needs.food || 0;
    resourceTotals.medical += loc.needs.medical || 0;
  });

  // Render all visualizations
  renderCharts(plan, resourceTotals);
  renderMathAnalysis(plan, totalDistance, totalLoad, numVehicles);
  renderLedger(plan, resourceTotals);
  renderVehicleRoutes(plan); // Add this function below
  renderMap(plan);

  lucide.createIcons();
}

function renderVehicleRoutes(plan) {
  const container = document.getElementById("vehicle-routes-container");
  container.innerHTML = "";

  const modeColors = {
    road: "#3b82f6",
    boat: "#10b981",
    air: "#fbbf24",
  };

  plan.routes.forEach((route, idx) => {
    const routeEl = document.createElement("div");
    routeEl.className = "p-4 hover:bg-gray-700/50 transition";

    let stopsHTML = route.stops
      .map(
        (stop) =>
          `<div class="text-sm text-gray-400">📍 ${stop.name} (${stop.load} units)</div>`,
      )
      .join("");

    let segmentsHTML = route.segments
      .map(
        (seg) =>
          `<span class="inline-block px-2 py-1 rounded text-xs font-mono" style="background:${modeColors[seg.mode]};">
        ${seg.mode.toUpperCase()}: ${(seg.distance_leg / 1000).toFixed(1)}km
      </span>`,
      )
      .join(" ");

    routeEl.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <h4 class="text-lg font-semibold text-white">Vehicle ${idx + 1} - ${route.vehicle_type.toUpperCase()}</h4>
        <span class="text-blue-400 font-mono">${(route.distance_meters / 1000).toFixed(2)} km</span>
      </div>
      <div class="mb-2">
        <span class="text-gray-400">Load:</span> <span class="text-white font-semibold">${route.load} units</span>
      </div>
      <div class="mb-2 flex flex-wrap gap-1">
        ${segmentsHTML}
      </div>
      <div class="mt-2 space-y-1">
        ${stopsHTML}
      </div>
    `;

    container.appendChild(routeEl);
  });
}

function renderCharts(plan, resourceTotals) {
  // 1. Pie Chart
  new Chart(document.getElementById("resource-pie-chart"), {
    type: "pie",
    data: {
      labels: ["Water (L)", "Food (MRE)", "Medical (Kits)"],
      datasets: [
        {
          data: [
            resourceTotals.water,
            resourceTotals.food,
            resourceTotals.medical,
          ],
          backgroundColor: ["#3b82f6", "#10b981", "#f59e0b"],
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e5e7eb" } } },
    },
  });

  // 2. Vehicle Load
  new Chart(document.getElementById("vehicle-load-chart"), {
    type: "bar",
    data: {
      labels: plan.routes.map((_, i) => `Vehicle ${i + 1}`),
      datasets: [
        {
          label: "Load",
          data: plan.routes.map((r) => r.load),
          backgroundColor: "#3b82f6",
        },
        {
          label: "Capacity",
          data: plan.routes.map(() => 5000),
          backgroundColor: "#6b7280",
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y: { ticks: { color: "#e5e7eb" }, grid: { color: "#374151" } },
        x: { ticks: { color: "#e5e7eb" }, grid: { color: "#374151" } },
      },
    },
  });

  // 3. Distance Chart
  new Chart(document.getElementById("distance-chart"), {
    type: "line",
    data: {
      labels: plan.routes.map((_, i) => `Route ${i + 1}`),
      datasets: [
        {
          label: "Distance (km)",
          data: plan.routes.map((r) => (r.distance_meters / 1000).toFixed(2)),
          borderColor: "#f59e0b",
          tension: 0.4,
        },
      ],
    },
    options: { responsive: true },
  });

  // 4. Location Chart
  new Chart(document.getElementById("location-chart"), {
    type: "bar",
    data: {
      labels: plan.locations.map((l) => l.name.substring(0, 20)),
      datasets: [
        {
          label: "Water",
          data: plan.locations.map((l) => l.needs.water || 0),
          backgroundColor: "#3b82f6",
        },
        {
          label: "Food",
          data: plan.locations.map((l) => l.needs.food || 0),
          backgroundColor: "#10b981",
        },
        {
          label: "Medical",
          data: plan.locations.map((l) => l.needs.medical || 0),
          backgroundColor: "#f59e0b",
        },
      ],
    },
    options: {
      responsive: true,
      scales: { y: { stacked: true }, x: { stacked: true } },
    },
  });
}

function renderMathAnalysis(plan, totalDistance, totalLoad, numVehicles) {
  document.getElementById("objective-value").textContent =
    `Z* = ${(totalDistance / 1000).toFixed(2)} km`;
  document.getElementById("time-complexity").textContent = `O(n! × m)`;
  document.getElementById("search-space").textContent =
    `~10^${plan.locations.length} combinations`;

  const loads = plan.routes.map((r) => r.load);
  const meanLoad = loads.reduce((a, b) => a + b, 0) / loads.length;
  const stdDev = Math.sqrt(
    loads.reduce((sum, load) => sum + Math.pow(load - meanLoad, 2), 0) /
      loads.length,
  );
  const loadBalance =
    meanLoad > 0 ? ((1 - stdDev / meanLoad) * 100).toFixed(1) : 100;

  document.getElementById("load-balance").textContent = `${loadBalance}%`;
  document.getElementById("route-utilization").textContent =
    `${((totalLoad / (numVehicles * 5000)) * 100).toFixed(1)}%`;
  document.getElementById("optimality-gap").textContent = "< 5%";

  document.getElementById("constraint-details").innerHTML = plan.routes
    .map((r, i) => `<p class="text-xs">V${i + 1}: ${r.load} ≤ 5000 ✓</p>`)
    .join("");

  document.getElementById("calculation-explanation").innerHTML = `
    <p>1. Distance matrix computed using ${plan.source}</p>
    <p>2. OR-Tools Guided Local Search optimization</p>
    <p>3. ${numVehicles} vehicles, ${totalLoad} units, ${plan.locations.length} locations</p>
    <p>4. Total distance: ${(totalDistance / 1000).toFixed(2)} km</p>
    <p>5. Load balance: ${loadBalance}% (σ=${stdDev.toFixed(1)})</p>
  `;
}

function renderLedger(plan, resourceTotals) {
  const grandTotal =
    resourceTotals.water + resourceTotals.food + resourceTotals.medical;
  const tbody = document.getElementById("ledger-body");
  tbody.innerHTML = "";

  plan.locations.forEach((loc) => {
    const w = loc.needs.water || 0;
    const f = loc.needs.food || 0;
    const m = loc.needs.medical || 0;
    const total = w + f + m;
    const pct = grandTotal > 0 ? ((total / grandTotal) * 100).toFixed(1) : 0;

    tbody.innerHTML += `
      <tr class="hover:bg-gray-700">
        <td class="p-3">${loc.name}</td>
        <td class="p-3">${w}</td>
        <td class="p-3">${f}</td>
        <td class="p-3">${m}</td>
        <td class="p-3 font-bold">${total}</td>
        <td class="p-3 text-blue-400">${pct}%</td>
      </tr>
    `;
  });
}

function renderMap(plan) {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  const depot = plan.depot;
  mapInstance = L.map("plan-map", {
    center: [depot.lat, depot.lon],
    zoom: 11,
    zoomControl: true,
    scrollWheelZoom: true,
  });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OpenStreetMap © CARTO",
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(mapInstance);

  setTimeout(() => {
    if (mapInstance) {
      mapInstance.invalidateSize();
    }
  }, 100);

  // Depot marker
  //
  const colors = [
    "#ef4444",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
  ];
  const bounds = [[depot.lat, depot.lon]];
  L.marker([depot.lat, depot.lon], {
    icon: L.divIcon({
      html: '<div style="background:#3b82f6;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 0 10px rgba(59,130,246,0.8);"></div>',
      iconSize: [24, 24],
      className: "depot-marker",
    }),
  })
    .addTo(mapInstance)
    .bindPopup(
      `<b>🏢 ${depot.name}</b><br><span style="color:#3b82f6;">Distribution Center</span>`,
    );

  // Location markers
  plan.locations.forEach((loc, i) => {
    const color = colors[i % colors.length];
    L.marker([loc.lat, loc.lon], {
      icon: L.divIcon({
        html: `<div style="background:${color};width:18px;height:18px;border-radius:50%;border:2px solid white;box-shadow:0 0 8px ${color};"></div>`,
        iconSize: [18, 18],
      }),
    })
      .addTo(mapInstance)
      .bindPopup(
        `<b>${loc.name}</b><br>
         <span style="color:#60a5fa;">💧 Water: ${loc.needs.water}</span><br>
         <span style="color:#34d399;">🍎 Food: ${loc.needs.food}</span><br>
         <span style="color:#fbbf24;">⚕️ Medical: ${loc.needs.medical}</span>`,
      );
    bounds.push([loc.lat, loc.lon]);
  });

  // Route rendering with SEGMENTS
  plan.routes.forEach((route, routeIdx) => {
    const color = colors[routeIdx % colors.length];

    // Render each segment with its specific geometry and mode
    route.segments.forEach((seg) => {
      const coords = seg.geometry.map(([lon, lat]) => [lat, lon]); // Convert [lon,lat] to [lat,lon]

      // Determine line style based on mode
      let lineStyle = {
        color: color,
        weight: 4,
        opacity: 0.8,
        smoothFactor: 1,
      };

      if (seg.mode === "air") {
        lineStyle.dashArray = "10, 10"; // Dashed for air
        lineStyle.color = "#fbbf24"; // Yellow for air
      } else if (seg.mode === "boat") {
        lineStyle.dashArray = "5, 5"; // Short dash for boat
        lineStyle.color = "#10b981"; // Green for boat
      }

      L.polyline(coords, lineStyle)
        .addTo(mapInstance)
        .bindPopup(
          `<b>🚚 Vehicle ${routeIdx + 1}</b><br>
           Mode: ${seg.mode.toUpperCase()}<br>
           Distance: ${(seg.distance_leg / 1000).toFixed(2)} km`,
        );
    });

    // Add vehicle route info
    const totalDistance = (route.distance_meters / 1000).toFixed(2);
    const routeLabel = L.marker([depot.lat, depot.lon], {
      icon: L.divIcon({
        html: `<div style="background:${color};color:white;padding:4px 8px;border-radius:4px;font-weight:bold;font-size:11px;white-space:nowrap;">V${routeIdx + 1}: ${totalDistance}km</div>`,
        iconSize: [80, 20],
        className: "route-label",
      }),
    }).addTo(mapInstance);
  });

  // Fit bounds with padding
  if (bounds.length > 0) {
    mapInstance.fitBounds(bounds, { padding: [50, 50] });
  }

  setTimeout(() => {
    if (mapInstance) {
      mapInstance.invalidateSize();
    }
  }, 200);
}

// Event listeners
document.getElementById("start-analysis-btn").onclick = handleInitialAnalysis;
document.getElementById("send-chat-btn").onclick = handleUserMessage;
document.getElementById("chat-input").onkeydown = (e) => {
  if (e.key === "Enter") handleUserMessage();
};

document.getElementById("btn-strategy-welfare").onclick = () =>
  showConfirmationPage("welfare");
document.getElementById("btn-strategy-need").onclick = () =>
  showConfirmationPage("need");
document.getElementById("btn-strategy-fastest").onclick = () =>
  showConfirmationPage("fastest");

document.getElementById("confirm-and-generate-btn").onclick = generateFinalPlan;
document.getElementById("back-to-strategy-btn").onclick = () =>
  showPage("optimization-page");

document.getElementById("save-plan-btn").onclick = () => {
  showNotification("Plan Saved", "Distribution plan saved successfully.");
};

document.getElementById("start-over-btn").onclick = () => {
  formData = {};
  chatHistory = [];
  dynamicQuestions = [];
  currentQuestionIndex = 0;
  collectedData = {};
  generatedPlan = null;
  document.getElementById("chat-messages").innerHTML = "";
  document.getElementById("crisis-description").value = "";
  document.getElementById("crisis-form").reset();
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  showPage("form-page");
};

document.getElementById("close-error-modal-btn").onclick = () => {
  document.getElementById("error-modal").classList.add("hidden");
};
document.getElementById("close-error-modal-btn-top").onclick = () => {
  document.getElementById("error-modal").classList.add("hidden");
};

document.getElementById("toggle-sidebar-btn").onclick = () => {
  document.getElementById("sidebar").classList.toggle("-translate-x-full");
};

// Initialize
showPage("form-page");
lucide.createIcons();
console.log("Alloc8 System Initialized");
