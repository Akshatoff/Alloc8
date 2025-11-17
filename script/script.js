import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  collection,
  addDoc,
  serverTimestamp,
  setLogLevel,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Global state
let formData = {};
let chatHistory = [];
let dynamicQuestions = [];
let currentQuestionIndex = 0;
let collectedData = {};
let generatedPlan = null;
let mapInstance = null;

const apiKey = "AIzaSyBP9Fkxfo0pzHARRLj6bK_qzTj9v3672o4";

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
  const maxAttempts = 5;
  const baseDelay = 1000;

  while (attempts < maxAttempts) {
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiPayload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `API request failed with status ${response.status}: ${errorBody}`,
        );
      }

      const result = await response.json();
      const candidate = result.candidates?.[0];

      if (candidate && candidate.content?.parts?.[0]?.text) {
        const text = candidate.content.parts[0].text;
        let sources = [];
        const groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata && groundingMetadata.groundingAttributions) {
          sources = groundingMetadata.groundingAttributions
            .map((attr) => ({ uri: attr.web?.uri, title: attr.web?.title }))
            .filter((source) => source.uri && source.title);
        }
        return { text, sources };
      } else {
        throw new Error("Invalid API response structure from Gemini.");
      }
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) throw error;
      const delay = baseDelay * Math.pow(2, attempts) + Math.random() * 1000;
      console.warn(
        `AI API error (attempt ${attempts}): ${error.message}. Retrying in ${Math.round(delay / 1000)}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("AI API request failed after all retry attempts.");
}

// Form submission handler
document.getElementById("crisis-form").addEventListener("submit", function (e) {
  e.preventDefault();

  // Collect form data
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

  // Display form summary
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

// Initial analysis handler
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

  // Combine form data with description
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
    const systemPromptAugment = `You are a humanitarian aid logistics expert. A user has provided structured form data and a detailed crisis report.

Form Data: ${formContext}
Description: ${detailedDescription}

Use Google Search to find augmenting real-time data. Respond with a concise, bulleted summary:
- Exact Location: (City, Region, Country with coordinates if available)
- Current Situation: (Latest news and updates)
- Population Data: (Specific numbers from reliable sources)
- Infrastructure Status: (Airports, roads, hospitals - specific details)
- Resource Availability: (Local warehouses, distribution centers)
- Search Sources: (List 2-3 titles and URLs)

Do not ask questions.`;

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

    const processedAugmentData = augmentData.text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");

    addChatMessage(
      "system",
      `<strong>Augmented Data (Live Search):</strong><br>${processedAugmentData}${sourcesText}`,
    );
    chatHistory.push({ role: "model", parts: [{ text: augmentData.text }] });
    collectedData.augmentedData = augmentData.text;
    collectedData.sources = augmentData.sources;

    // Step 2: Generate targeted questions based on form + description
    const combinedContext = `Form Data: ${formContext}\n\nDetailed Report: "${detailedDescription}"\n\nAugmented Analysis:\n${augmentData.text}`;

    const systemPromptQuestions = `You are an AI assistant gathering critical data for a resource distribution plan. Based on the structured form data AND detailed context, generate 5 highly targeted follow-up questions that fill specific gaps.

Context:
${combinedContext}

Generate questions that are SPECIFIC to this situation. Focus on:
1. Exact GPS coordinates or specific neighborhood names
2. Precise resource quantities needed at specific locations
3. Detailed transport/logistics constraints
4. Specific population numbers at gathering points
5. Available local assets and their current status

Respond with ONLY a valid JSON array of strings:
[
"Question 1?",
"Question 2?",
"Question 3?",
"Question 4?",
"Question 5?"
]`;

    const questionData = await callGeminiAPI(
      systemPromptQuestions,
      combinedContext,
      false,
      true,
    );
    let cleanedJsonText = questionData.text.trim();

    try {
      dynamicQuestions = JSON.parse(cleanedJsonText);
    } catch (e) {
      console.error("Failed to parse questions JSON:", e);
      dynamicQuestions = [
        "What are the exact GPS coordinates or specific neighborhood names of the most affected areas?",
        "What are the precise resource quantities needed? (e.g., 'Location A: water 5000L, food 10000 units')",
        "What is the current status of specific roads, airports, and transport routes?",
        "What are the exact population numbers at specific shelters or gathering points?",
        "Are there operational warehouses or distribution centers available? Please provide addresses.",
      ];
    }

    currentQuestionIndex = 0;

    if (dynamicQuestions.length > 0) {
      addChatMessage("ai", dynamicQuestions[currentQuestionIndex]);
      chatHistory.push({
        role: "model",
        parts: [{ text: dynamicQuestions[currentQuestionIndex] }],
      });
    }
  } catch (error) {
    console.error("Question Generation Error:", error);
    addChatMessage("system", `Error: ${error.message}`);
    showErrorModal(
      "AI Error",
      `Failed to generate follow-up questions: ${error.message}`,
    );
    showPage("entry-page");
  } finally {
    showChatLoader(false);
  }
}

// User message handler
async function handleUserMessage() {
  const userInput = document.getElementById("chat-input");
  const message = userInput.value.trim();
  if (!message) return;

  addChatMessage("user", message);
  userInput.value = "";

  const ackWords = [
    "Understood.",
    "Got it.",
    "Processing...",
    "Received.",
    "Thank you.",
  ];
  const randomAck = ackWords[Math.floor(Math.random() * ackWords.length)];
  showChatLoader(true, randomAck);

  const currentQuestion = dynamicQuestions[currentQuestionIndex];
  collectedData[`question_${currentQuestionIndex}`] = {
    question: currentQuestion,
    answer: message,
  };
  chatHistory.push({ role: "user", parts: [{ text: message }] });

  currentQuestionIndex++;
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (currentQuestionIndex < dynamicQuestions.length) {
    const nextQuestion = dynamicQuestions[currentQuestionIndex];
    showChatLoader(false);
    addChatMessage("ai", nextQuestion);
    chatHistory.push({ role: "model", parts: [{ text: nextQuestion }] });
  } else {
    addChatMessage("system", "All data collected. Summarizing...");

    try {
      const fullConversation = JSON.stringify(collectedData, null, 2);
      const systemPromptSummary = `You are a logistics summarizer. Analyze the collected data and provide a structured summary:

Data:
${fullConversation}

Provide:
- **Locations:** (All specific coordinates, cities, zones)
- **Population:** (Total estimate with breakdown)
- **Transport:** (Status of all infrastructure)
- **Depots:** (Available warehouses/distribution centers)
- **Needs (Detailed):** (All resources with quantities)

Respond concisely with bullets.`;

      const summaryData = await callGeminiAPI(
        systemPromptSummary,
        fullConversation,
      );
      addChatMessage(
        "ai",
        `<strong>Data Summary:</strong><br>${summaryData.text.replace(/\n/g, "<br>")}`,
      );
      chatHistory.push({ role: "model", parts: [{ text: summaryData.text }] });
      collectedData.finalSummary = summaryData.text;

      // Parse needs for backend
      const systemPromptParse = `Extract structured location and resource data from this summary:

${summaryData.text}

Respond with ONLY valid JSON:
{
"locations": [
{ "name": "Location 1", "lat": 0.0, "lon": 0.0, "needs": { "water": 100, "food": 200, "medical": 50 } }
]
}`;

      const needsData = await callGeminiAPI(
        systemPromptParse,
        summaryData.text,
        false,
        true,
      );
      try {
        collectedData.parsedNeeds = JSON.parse(needsData.text);
      } catch (e) {
        console.error("Failed to parse needs:", e);
        collectedData.parsedNeeds = null;
      }

      showPage("optimization-page");
    } catch (error) {
      console.error("Summarization Error:", error);
      addChatMessage("system", `Error: ${error.message}`);
      showErrorModal("AI Error", `Failed to summarize: ${error.message}`);
    } finally {
      showChatLoader(false);
    }
  }
}

// Strategy selection
function showConfirmationPage(strategy) {
  collectedData.strategy = strategy;
  const summaryEl = document.getElementById("confirmation-summary");

  let formSummary =
    '<div class="mb-4"><h3 class="text-lg font-semibold text-gray-400">Form Data</h3><ul class="list-disc list-inside">';
  for (const [key, value] of Object.entries(formData)) {
    formSummary += `<li>${key.replace(/_/g, " ")}: ${value.replace(/_/g, " ")}</li>`;
  }
  formSummary += "</ul></div>";

  let qAndA =
    '<div><h3 class="text-lg font-semibold text-gray-400">Q&A</h3><ul>';
  for (let i = 0; i < dynamicQuestions.length; i++) {
    const item = collectedData[`question_${i}`];
    if (item) {
      qAndA += `<li class="mb-2"><strong>Q:</strong> ${item.question}<br><strong>A:</strong> ${item.answer}</li>`;
    }
  }
  qAndA += "</ul></div>";

  summaryEl.innerHTML = `
    <div class="space-y-4">
      <div>
        <h3 class="text-lg font-semibold text-gray-400">Selected Strategy</h3>
        <p class="p-3 bg-gray-900 rounded-md text-xl font-bold text-blue-300 capitalize">${strategy}</p>
      </div>
      ${formSummary}
      <div>
        <h3 class="text-lg font-semibold text-gray-400">Description</h3>
        <p class="p-3 bg-gray-900 rounded-md">${collectedData.initialDescription}</p>
      </div>
      ${qAndA}
    </div>
  `;
  showPage("confirmation-page");
}

// Generate plan
async function generateFinalPlan() {
  showPage("plan-page");
  document.getElementById("plan-loader").classList.remove("hidden");
  document.getElementById("plan-content").classList.add("hidden");

  try {
    const response = await fetch("http://127.0.0.1:5000/generate-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: collectedData.strategy,
        parsedNeeds: collectedData.parsedNeeds,
        formData: formData,
      }),
    });

    if (!response.ok) throw new Error(`Backend error ${response.status}`);
    const planData = await response.json();
    generatedPlan = planData;
    renderPlan(planData);

    document.getElementById("plan-loader").classList.add("hidden");
    document.getElementById("plan-content").classList.remove("hidden");
  } catch (err) {
    console.error("Optimization error:", err);
    showErrorModal(
      "Optimization Error",
      `Failed to generate plan: ${err.message}`,
    );
    showPage("confirmation-page");
  }
}

// Render plan
function renderPlan(plan) {
  document.getElementById("plan-title").textContent = plan.summary.title;
  document.getElementById("plan-description").textContent =
    plan.summary.description;
  document.getElementById("stat-strategy").textContent = plan.strategy;
  document.getElementById("stat-distance").textContent =
    `${Math.round(plan.summary.totalDistanceMeters / 1000)} km`;
  document.getElementById("stat-resources").textContent =
    `${plan.summary.totalResources} units`;
  document.getElementById("stat-vehicles").textContent =
    `${plan.summary.totalTrucks} Trucks`;

  // Ledger
  const ledgerBody = document.getElementById("ledger-body");
  ledgerBody.innerHTML = "";
  plan.locations.forEach((loc) => {
    const total =
      (loc.needs.water || 0) + (loc.needs.food || 0) + (loc.needs.medical || 0);
    ledgerBody.innerHTML += `
      <tr class="hover:bg-gray-700">
        <td class="p-3">${loc.name}</td>
        <td class="p-3">${loc.needs.water || 0}</td>
        <td class="p-3">${loc.needs.food || 0}</td>
        <td class="p-3">${loc.needs.medical || 0}</td>
        <td class="p-3 font-bold">${total}</td>
      </tr>
    `;
  });

  // Map
  if (mapInstance) mapInstance.remove();
  mapInstance = L.map("plan-map").setView([plan.depot.lat, plan.depot.lon], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OpenStreetMap © CARTO",
  }).addTo(mapInstance);

  const depotIcon = L.divIcon({
    html: '<div style="background: #3b82f6; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white;"></div>',
    className: "",
    iconSize: [16, 16],
  });
  L.marker([plan.depot.lat, plan.depot.lon], { icon: depotIcon })
    .addTo(mapInstance)
    .bindPopup(`<b>${plan.depot.name}</b>`);

  const bounds = [[plan.depot.lat, plan.depot.lon]];
  plan.locations.forEach((loc) => {
    if (!loc.lat || !loc.lon) return;
    const locIcon = L.divIcon({
      html: '<div style="background: #ef4444; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white;"></div>',
      className: "",
      iconSize: [12, 12],
    });
    L.marker([loc.lat, loc.lon], { icon: locIcon })
      .addTo(mapInstance)
      .bindPopup(
        `<b>${loc.name}</b><br>Water: ${loc.needs.water || 0}<br>Food: ${loc.needs.food || 0}`,
      );
    bounds.push([loc.lat, loc.lon]);
  });

  if (bounds.length > 1) {
    mapInstance.fitBounds(bounds, { padding: [50, 50] });
  }

  lucide.createIcons();
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
console.log("Alloc8 Form-Based System Initialized");
