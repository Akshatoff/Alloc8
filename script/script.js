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

// --- Global Variables ---
let db, auth;
let userId;
let appId;
let chatHistory = [];
let dynamicQuestions = [];
let currentQuestionIndex = 0;
let collectedData = {};
let generatedPlan = null;
let mapInstance = null;

// --- 1. AI API Key ---
// ATTENTION: Paste your Google AI Studio API key here!
// Get one for free at https://aistudio.google.com/app/apikey
const apiKey = "AIzaSyBP9Fkxfo0pzHARRLj6bK_qzTj9v3672o4"; // <--- PUT AI KEY HERE

// --- 2. Firebase Config and Init ---
// ATTENTION: Paste your own Firebase project configuration here!
const firebaseConfig = {
  apiKey: "AIzaSyBhliGUFEJ7QiVwTAUXAsL-Tv4GNFZPATQ",
  authDomain: "alloc8-fc09f.firebaseapp.com",
  projectId: "alloc8-fc09f",
  storageBucket: "alloc8-fc09f.firebasestorage.app",
  messagingSenderId: "938509665123",
  appId: "1:938509665123:web:0d83ce05eb59e3cf604956",
  measurementId: "G-051ELH05LR",
};
// If your config is empty, the app will not connect to Firestore.
if (firebaseConfig.projectId === "YOUR_PROJECT_ID") {
  console.warn(
    "Firebase config is not set. Please paste your project config in alloc8.html. Firestore features will not work.",
  );
}
// Check for AI Key
if (apiKey === "YOUR_GEMINI_API_KEY") {
  console.warn(
    "Gemini API key is not set. Please paste your API key in alloc8.html. AI features will not work.",
  );
}

appId = firebaseConfig.projectId || "alloc8-demo";

// Initialize Firebase
try {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  setLogLevel("debug");

  // Sign in
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      console.log("User is signed in:", user.uid);
      userId = user.uid;
      document.getElementById("user-id-display").textContent =
        `User ID: ${userId}`;
      listenForPlans(); // Start listening for saved plans
    } else {
      console.log("User is not signed in, attempting anonymous sign-in.");
      try {
        // Use __initial_auth_token if available (Canvas env)
        if (
          typeof __initial_auth_token !== "undefined" &&
          __initial_auth_token
        ) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          // Fallback for local dev
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Anonymous Sign-In Error:", error);
        // Display error to user in a modal
        showErrorModal(
          "Firebase Auth Error",
          `Could not sign in: ${error.message}. Firestore features will be disabled.`,
        );
      }
    }
  });
} catch (e) {
  console.error("Firebase Initialization Error:", e);
  showErrorModal(
    "Firebase Init Error",
    "Could not initialize Firebase. Please check your `firebaseConfig` object in the HTML file. Saved plans will not work.",
  );
}

// --- Core Functions ---

/**
 * Shows the specified page and hides all others.
 * @param {string} pageId - The ID of the page section to show.
 */
function showPage(pageId) {
  document.querySelectorAll(".page-section").forEach((section) => {
    section.classList.add("hidden");
  });
  document.getElementById(pageId).classList.remove("hidden");

  // Special handling for map initialization
  if (pageId === "plan-page" && mapInstance) {
    // Leaflet maps need to be invalidated if their container was hidden
    setTimeout(() => mapInstance.invalidateSize(), 100);
  }
}

/**
 * Adds a message to the chat UI.
 * @param {string} sender - 'user', 'ai', or 'system'.
 * @param {string} text - The chat message text.
 */
function addChatMessage(sender, text) {
  const chatMessages = document.getElementById("chat-messages");
  const messageEl = document.createElement("div");

  let bgColor, textColor, align, senderName;

  switch (sender) {
    case "user":
      bgColor = "bg-blue-600";
      textColor = "text-white";
      align = "self-end";
      senderName = "You";
      break;
    case "ai":
      bgColor = "bg-gray-700";
      textColor = "text-gray-200";
      align = "self-start";
      senderName = "Alloc8 AI";
      break;
    default: // system
      bgColor = "bg-gray-800";
      textColor = "text-yellow-400";
      align = "self-center";
      senderName = "System";
      break;
  }

  messageEl.className = `w-full max-w-lg p-3 my-2 rounded-lg ${bgColor} ${textColor} ${align} shadow-md`;
  messageEl.innerHTML = `<strong class="block text-sm">${senderName}</strong><p>${text}</p>`;

  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight; // Auto-scroll
}

/**
 * Shows a loading indicator in the chat.
 * @param {boolean} show - Whether to show or hide the loader.
 * @param {string} [text] - Optional text to display.
 */
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

// --- AI API Call Function ---

/**
 * Calls the Gemini AI API with exponential backoff.
 * @param {string} systemPrompt - The system-level instruction for the AI.
 * @param {string} userQuery - The user's prompt.
 * @param {boolean} [useGrounding=false] - Whether to use Google Search grounding.
 * @param {boolean} [jsonResponse=false] - Whether to request a JSON response.
 * @returns {Promise<object>} - An object containing `text` and `sources`.
 */
async function callGeminiAPI(
  systemPrompt,
  userQuery,
  useGrounding = false,
  jsonResponse = false,
) {
  if (apiKey === "YOUR_GEMINI_API_KEY") {
    console.error("Gemini API key is not set.");
    showErrorModal(
      "AI Error",
      "Gemini API key is not set. Please paste your API key in alloc8.html to enable AI features.",
    );
    throw new Error("Gemini API key is not set.");
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const apiPayload = {
    contents: [{ parts: [{ text: userQuery }] }],
  };

  if (systemPrompt) {
    apiPayload.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  if (useGrounding) {
    apiPayload.tools = [{ google_search: {} }];
  }

  if (jsonResponse) {
    apiPayload.generationConfig = {
      responseMimeType: "application/json",
    };
  }

  let attempts = 0;
  const maxAttempts = 5;
  const baseDelay = 1000; // 1 second

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

        // Extract sources if grounding was used
        let sources = [];
        const groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata && groundingMetadata.groundingAttributions) {
          sources = groundingMetadata.groundingAttributions
            .map((attr) => ({
              uri: attr.web?.uri,
              title: attr.web?.title,
            }))
            .filter((source) => source.uri && source.title);
        }

        return { text: text, sources: sources };
      } else {
        console.error("Invalid API response structure:", result);
        throw new Error("Invalid API response structure from Gemini.");
      }
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        console.error("AI API Error (Max attempts reached):", error);
        throw error; // Re-throw after max attempts
      }
      const delay = baseDelay * Math.pow(2, attempts) + Math.random() * 1000;
      console.warn(
        `AI API error (attempt ${attempts}): ${error.message}. Retrying in ${Math.round(delay / 1000)}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // This part should not be reachable, but as a fallback:
  throw new Error("AI API request failed after all retry attempts.");
}

// --- Event Handlers ---

/**
 * Handles the initial analysis of the crisis description.
 */
async function handleInitialAnalysis() {
  const initialPrompt = document.getElementById("crisis-description").value;
  if (!initialPrompt) {
    showErrorModal("Input Required", "Please describe the crisis situation.");
    return;
  }
  if (apiKey === "YOUR_GEMINI_API_KEY") {
    showErrorModal(
      "AI Key Missing",
      "AI functions are disabled. Please add your Gemini API key to the alloc8.html file to enable AI analysis.",
    );
    return;
  }

  showPage("chat-page");
  addChatMessage("user", initialPrompt);
  showChatLoader(true);

  collectedData = { initialDescription: initialPrompt };
  chatHistory.push({ role: "user", parts: [{ text: initialPrompt }] });

  try {
    // --- Step 1: Augment data with Google Search ---
    const systemPromptAugment = `You are a humanitarian aid logistics expert. A user has provided an initial crisis report. Use Google Search to find augmenting data (like exact location, population density, recent news, infrastructure status).
         Respond with a concise, bulleted summary of this augmented data.
         - Location: (City, Region, Country)
         - Incident Type: (e.g., Earthquake, Flood)
         - Population Affected (Estimate): (e.g., "City of 50k", "Region of 2M")
         - Key Infrastructure (Status): (e.g., "Main airport (XXX) reportedly closed", "Highway 405 blocked")
         - Urgent Needs (Inferred): (e.g., "Water, Shelter, Medical")
         - Search Sources: (List 1-2 titles and URLs from your search)

         Do not ask questions.`;

    const augmentData = await callGeminiAPI(
      systemPromptAugment,
      initialPrompt,
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
      `**Augmented Data (Live Search):**\n${augmentData.text.replace(/\n/g, "<br>")}${sourcesText}`,
    );
    chatHistory.push({ role: "model", parts: [{ text: augmentData.text }] });
    collectedData.augmentedData = augmentData.text;
    collectedData.sources = augmentData.sources;

    // --- Step 2: Generate dynamic questions ---
    const combinedContext = `Initial Report: "${initialPrompt}"\n\nAugmented Analysis:\n${augmentData.text}`;

    const systemPromptQuestions = `You are an AI assistant gathering critical data for a resource distribution plan. Based on this context, you MUST generate 5 critical follow-up questions.
         The questions must be programmatic and cover:
         1.  **Specific Locations:** (e.g., "What are the exact neighborhoods or GPS coordinates of the affected zones?")
         2.  **Resource Needs (Specifics):** (e.g., "What are the specific resource needs? Please list items and quantities, like 'water: 5000L, food: 10000 units, medical kits: 500'.")
         3.  **Transport Logistics:** (e.g., "What is the on-ground condition of the main airport (code XXX) and highway Y?")
         4.  **Affected Population (Specifics):** (e.g., "What are the estimated numbers at specific rally points or shelters?")
         5.  **Local Assets:** (e.g., "Are there any local warehouses, distribution partners, or supply depots still intact?")

         Respond with ONLY a valid JSON array of strings. Do not include "'''json" or any other text.
         Example:
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

    // The API response is now guaranteed to be JSON text
    let cleanedJsonText = questionData.text.trim();

    // Parse the JSON array of questions
    try {
      dynamicQuestions = JSON.parse(cleanedJsonText);
    } catch (e) {
      console.error(
        "Failed to parse questions JSON:",
        e,
        "Raw text:",
        cleanedJsonText,
      );
      // Fallback if JSON is somehow still malformed
      dynamicQuestions = [
        "What are the exact neighborhoods or GPS coordinates of the affected zones?",
        "What are the specific resource needs (e.g., 'water: 5000L', 'food: 10000 units')?",
        "What is the on-ground condition of main roads and airports?",
        "What are the estimated numbers at specific rally points or shelters?",
        "Are there any local warehouses or supply depots still intact?",
      ];
    }

    currentQuestionIndex = 0;

    // Ask the first question
    if (dynamicQuestions.length > 0) {
      addChatMessage("ai", dynamicQuestions[currentQuestionIndex]);
      chatHistory.push({
        role: "model",
        parts: [{ text: dynamicQuestions[currentQuestionIndex] }],
      });
    }
  } catch (error) {
    console.error("Question Generation API Error:", error);
    addChatMessage(
      "system",
      `There was an error processing the initial analysis: ${error.message}. Please try again.`,
    );
    showErrorModal(
      "AI Error",
      `Failed to generate follow-up questions: ${error.message}`,
    );
    showPage("entry-page"); // Go back to entry
  } finally {
    showChatLoader(false);
  }
}

/**
 * Handles the user's reply to an AI-generated question.
 */
async function handleUserMessage() {
  const userInput = document.getElementById("chat-input");
  const message = userInput.value.trim();

  if (!message) return;

  addChatMessage("user", message);
  userInput.value = "";

  // --- Acknowledgment Flow ---
  const ackWords = [
    "Okay, got it.",
    "Understood.",
    "Alright, processing...",
    "Received.",
    "Thank you.",
  ];
  const randomAck = ackWords[Math.floor(Math.random() * ackWords.length)];
  showChatLoader(true, randomAck);
  // ---------------------------

  // Store the answer
  const currentQuestion = dynamicQuestions[currentQuestionIndex];
  collectedData[`question_${currentQuestionIndex}`] = {
    question: currentQuestion,
    answer: message,
  };
  chatHistory.push({ role: "user", parts: [{ text: message }] });

  currentQuestionIndex++;

  // Wait for a moment to simulate thought
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (currentQuestionIndex < dynamicQuestions.length) {
    // Ask the next question
    const nextQuestion = dynamicQuestions[currentQuestionIndex];
    showChatLoader(false);
    addChatMessage("ai", nextQuestion);
    chatHistory.push({ role: "model", parts: [{ text: nextQuestion }] });
  } else {
    // All questions answered, move to optimization
    addChatMessage(
      "system",
      "All critical data collected. Summarizing and moving to optimization phase...",
    );

    // Summarize data for optimization
    try {
      const fullConversation = JSON.stringify(collectedData, null, 2);
      const systemPromptAnswer = `You are a logistics summarizer. A user has answered a series of questions about a crisis. Based on the following data, summarize the key logistical parameters.
             - **Locations:** (List all specific coordinates, cities, or zones mentioned)
             - **Population:** (Best total estimate)
             - **Transport:** (List status of all airports, roads, ports)
             - **Depots:** (List any available local warehouses)
             - **Needs (Raw):** (List all resources requested)

             Data:
             ${fullConversation}

             Respond with a concise bulleted summary. Do not ask questions.`;

      const fullQuery = `Summarize this data: ${fullConversation}`;
      const answerData = await callGeminiAPI(systemPromptAnswer, fullQuery);

      addChatMessage(
        "ai",
        `**Data Summary:**<br>${answerData.text.replace(/\n/g, "<br>")}`,
      );
      chatHistory.push({ role: "model", parts: [{ text: answerData.text }] });
      collectedData.finalSummary = answerData.text;

      // --- New Step: Parse needs for the ledger ---
      const systemPromptParseNeeds = `Analyze the "Needs (Raw)" section of this summary and extract a structured list of locations and their requested resources.
             Summary:
             ${answerData.text}

             Respond with ONLY a JSON object in this format:
             {
                 "locations": [
                     { "name": "Location Name 1", "needs": { "water": 100, "food": 200, "medical": 50 } },
                     { "name": "Location Name 2", "needs": { "water": 300, "food": 500 } }
                 ]
             }
             If you cannot find specific locations or numbers, provide a best-guess reasonable structure.
             `;
      const needsData = await callGeminiAPI(
        systemPromptParseNeeds,
        fullConversation,
        false,
        true,
      );
      try {
        collectedData.parsedNeeds = JSON.parse(needsData.text);
        console.log("Parsed needs:", collectedData.parsedNeeds);
      } catch (e) {
        console.error("Failed to parse needs JSON:", e, needsData.text);
        collectedData.parsedNeeds = null; // Fallback
      }
      // ------------------------------------------

      // Show the optimization page
      showPage("optimization-page");
    } catch (error) {
      console.error("Data Summarization Error:", error);
      addChatMessage("system", `Error summarizing data: ${error.message}`);
      showErrorModal(
        "AI Error",
        `Failed to summarize collected data: ${error.message}`,
      );
    } finally {
      showChatLoader(false);
    }
  }
}

/**
 * Shows the confirmation page with all collected data.
 * @param {string} strategy - The selected optimization strategy.
 */
function showConfirmationPage(strategy) {
  console.log(`Confirming strategy: ${strategy}`);
  collectedData.strategy = strategy;

  const summaryEl = document.getElementById("confirmation-summary");
  let qAndAHtml = "<ul>";
  for (let i = 0; i < dynamicQuestions.length; i++) {
    const item = collectedData[`question_${i}`];
    if (item) {
      qAndAHtml += `<li class="mb-2"><strong>Q:</strong> ${item.question}<br><strong>A:</strong> ${item.answer}</li>`;
    }
  }
  qAndAHtml += "</ul>";

  summaryEl.innerHTML = `
         <div class="space-y-4">
             <div>
                 <h3 class="text-lg font-semibold text-gray-400">Selected Strategy</h3>
                 <p class="p-3 bg-gray-900 rounded-md text-xl font-bold text-blue-300 capitalize">${strategy}</p>
             </div>
             <div>
                 <h3 class="text-lg font-semibold text-gray-400">Initial Description</h3>
                 <p class="p-3 bg-gray-900 rounded-md">${collectedData.initialDescription}</p>
             </div>
             <div>
                 <h3 class="text-lg font-semibold text-gray-400">Augmented Data</h3>
                 <p class="p-3 bg-gray-900 rounded-md">${collectedData.augmentedData.replace(/\n/g, "<br>")}</p>
             </div>
             <div>
                 <h3 class="text-lg font-semibold text-gray-400">Data Collection Q&A</h3>
                 <div class="p-3 bg-gray-900 rounded-md">${qAndAHtml}</div>
             </div>
         </div>
     `;

  showPage("confirmation-page");
}

/**
 * Simulates a plan based on the chosen strategy.
 */
function generateFinalPlan() {
  const strategy = collectedData.strategy;
  console.log(`Generating final plan for strategy: ${strategy}`);
  showPage("plan-page");
  document.getElementById("plan-loader").classList.remove("hidden");
  document.getElementById("plan-content").classList.add("hidden");

  // --- This is a simulation ---
  // In a real app, this would be a complex backend call to an
  // optimization engine (linear programming, ML, etc.)
  // We simulate the data that engine would return.

  // Simulate network delay
  setTimeout(() => {
    let simLocations = [
      {
        name: "Central Shelter",
        lat: 34.0522,
        lon: -118.2437,
        needs: { water: 500, food: 1000, medical: 200 },
      },
      {
        name: "North Zone",
        lat: 34.1522,
        lon: -118.2437,
        needs: { water: 300, food: 500, medical: 50 },
      },
      {
        name: "West Bridge",
        lat: 34.0522,
        lon: -118.3437,
        needs: { water: 200, food: 300, medical: 0 },
      },
    ];

    // --- DYNAMIC LEDGER ---
    // Try to use the parsed needs from the AI
    if (
      collectedData.parsedNeeds &&
      collectedData.parsedNeeds.locations &&
      collectedData.parsedNeeds.locations.length > 0
    ) {
      // Give them random lat/lon for simulation
      const baseLat = 34.05;
      const baseLon = -118.24;
      simLocations = collectedData.parsedNeeds.locations.map((loc, i) => ({
        name: loc.name,
        lat: baseLat + (Math.random() - 0.5) * 0.2 + i * 0.1,
        lon: baseLon + (Math.random() - 0.5) * 0.2,
        needs: {
          // Ensure defaults
          water: loc.needs.water || 0,
          food: loc.needs.food || 0,
          medical: loc.needs.medical || 0,
        },
      }));
    }
    // ------------------------

    const simData = {
      locations: simLocations,
      depot: { name: "Main Depot (LAX)", lat: 33.9416, lon: -118.4085 },
      // Sequential routes for "traveling salesman" path
      routes: [
        {
          type: "truck",
          from: "Main Depot (LAX)",
          to: simLocations[0].name,
          time: 45,
          dist: 25,
        },
        {
          type: "truck",
          from: simLocations[0].name,
          to: simLocations[1].name,
          time: 30,
          dist: 18,
        },
        {
          type: "drone",
          from: simLocations[1].name,
          to: simLocations[2] ? simLocations[2].name : "Main Depot (LAX)",
          time: 20,
          dist: 15,
        },
      ],
      summary: {
        totalTime: 45, // This now means MAX delivery time
        totalResources: simLocations.reduce(
          (acc, loc) =>
            acc +
            (loc.needs.water || 0) +
            (loc.needs.food || 0) +
            (loc.needs.medical || 0),
          0,
        ),
        totalTrucks: 2,
        totalDrones: 1,
      },
      strategy: strategy,
    };

    // Adjust simulation based on strategy
    let desc = "";
    switch (strategy) {
      case "welfare":
        simData.summary.title = "Plan: Maximum Welfare";
        desc =
          "This plan prioritizes delivering the most resources to the largest population centers.";
        break;
      case "need":
        simData.summary.title = "Plan: Highest Need";
        desc =
          "This plan prioritizes locations with the most critical medical needs.";
        // Swap route to show a change
        simData.routes[1] = {
          type: "drone",
          from: simLocations[0].name,
          to: simLocations[1].name,
          time: 20,
          dist: 15,
        };
        simData.routes[2] = {
          type: "truck",
          from: simLocations[1].name,
          to: simLocations[2] ? simLocations[2].name : "Main Depot (LAX)",
          time: 30,
          dist: 18,
        };
        break;
      case "fastest":
        simData.summary.title = "Plan: Fastest Results";
        desc =
          "This plan prioritizes the quickest delivery times to establish a foothold.";
        simData.summary.totalTime = 20; // Fastest single delivery
        break;
    }

    simData.summary.description = `${desc} The Est. Completion Time represents the longest single delivery (land or air) in the network.`;

    generatedPlan = simData; // Store the plan
    renderPlan(simData);

    document.getElementById("plan-loader").classList.add("hidden");
    document.getElementById("plan-content").classList.remove("hidden");
  }, 2500); // 2.5 second simulation
}

/**
 * Renders the generated plan data in the UI.
 * @param {object} plan - The simulated plan object.
 */
function renderPlan(plan) {
  // --- 1. Render Summary ---
  document.getElementById("plan-title").textContent = plan.summary.title;
  document.getElementById("plan-description").textContent =
    plan.summary.description;
  document.getElementById("stat-strategy").textContent = plan.strategy;
  document.getElementById("stat-time").textContent =
    `${plan.summary.totalTime} min`;
  document.getElementById("stat-resources").textContent =
    `${plan.summary.totalResources} units`;
  document.getElementById("stat-vehicles").textContent =
    `${plan.summary.totalTrucks} Trucks, ${plan.summary.totalDrones} Drones`;

  // --- 2. Render Resource Ledger ---
  const ledgerBody = document.getElementById("ledger-body");
  ledgerBody.innerHTML = ""; // Clear old data
  plan.locations.forEach((loc) => {
    const total =
      (loc.needs.water || 0) + (loc.needs.food || 0) + (loc.needs.medical || 0);
    const row = `
             <tr class="border-b border-gray-700 hover:bg-gray-700">
                 <td class="p-3">${loc.name}</td>
                 <td class="p-3">${loc.needs.water || 0}</td>
                 <td class="p-3">${loc.needs.food || 0}</td>
                 <td class="p-3">${loc.needs.medical || 0}</td>
                 <td class="p-3 font-bold">${total}</td>
             </tr>
         `;
    ledgerBody.innerHTML += row;
  });

  // --- 3. Render Map ---
  if (mapInstance) {
    mapInstance.remove();
  }
  mapInstance = L.map("plan-map").setView([plan.depot.lat, plan.depot.lon], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(mapInstance);

  // Add depot marker
  const depotIcon = L.divIcon({
    html: `<i data-lucide="warehouse" class="text-blue-400" style="width: 32px; height: 32px; transform: translate(-16px, -16px);"></i>`,
    className: "",
  });
  L.marker([plan.depot.lat, plan.depot.lon], { icon: depotIcon })
    .addTo(mapInstance)
    .bindPopup(`<b>${plan.depot.name}</b>`);

  // Add location markers
  const bounds = [[plan.depot.lat, plan.depot.lon]];
  const allLocations = {
    [plan.depot.name]: { lat: plan.depot.lat, lon: plan.depot.lon },
  };

  plan.locations.forEach((loc) => {
    if (!loc.lat || !loc.lon) {
      console.warn("Skipping location with missing lat/lon:", loc.name);
      return;
    }
    allLocations[loc.name] = { lat: loc.lat, lon: loc.lon };
    const locIcon = L.divIcon({
      html: `<i data-lucide="map-pin" class="text-red-500" style="width: 24px; height: 24px; transform: translate(-12px, -24px);"></i>`,
      className: "",
    });
    L.marker([loc.lat, loc.lon], { icon: locIcon })
      .addTo(mapInstance)
      .bindPopup(
        `<b>${loc.name}</b><br>Water: ${loc.needs.water || 0}<br>Food: ${loc.needs.food || 0}`,
      );
    bounds.push([loc.lat, loc.lon]);
  });

  // Add polylines for routes
  plan.routes.forEach((route) => {
    const fromLoc = allLocations[route.from];
    const toLoc = allLocations[route.to];

    if (!fromLoc || !toLoc) {
      console.warn("Could not find locations for route:", route);
      return;
    }

    const style =
      route.type === "truck"
        ? { color: "#fb923c", weight: 3, opacity: 0.8 } // orange
        : { color: "#60a5fa", weight: 2, opacity: 1, dashArray: "5, 5" }; // blue dashed

    L.polyline(
      [
        [fromLoc.lat, fromLoc.lon],
        [toLoc.lat, toLoc.lon],
      ],
      style,
    )
      .addTo(mapInstance)
      .bindPopup(
        `${route.type.toUpperCase()} Route<br>${route.from} -> ${route.to}<br>${route.dist} km, ${route.time} min`,
      );
  });

  if (bounds.length > 1) {
    mapInstance.fitBounds(bounds, { padding: [50, 50] });
  }

  // Re-render icons
  lucide.createIcons();
}

// --- Firestore Functions ---

/**
 * Saves the currently generated plan to Firestore.
 */
async function savePlan() {
  // --- NEW: Check for valid config before saving ---
  if (firebaseConfig.projectId === "YOUR_PROJECT_ID") {
    showErrorModal(
      "Firebase Not Configured",
      "Cannot save plan. Please paste your `firebaseConfig` details into the alloc8.html file to enable saving.",
    );
    return;
  }
  if (!generatedPlan) {
    showErrorModal("No Plan", "There is no plan generated to save.");
    return;
  }
  if (!db || !userId || !appId) {
    showErrorModal(
      "Save Error",
      "Cannot save plan. Database not connected. Check console for Firebase errors.",
    );
    return;
  }
  // ------------------------------------------------

  const saveButton = document.getElementById("save-plan-btn");
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";

  try {
    // Use a 'public' collection to share plans among users
    const collectionPath = `artifacts/${appId}/public/data/plans`;

    // Add a new document with a generated id
    const docRef = await addDoc(collection(db, collectionPath), {
      userId: userId,
      planData: JSON.stringify(generatedPlan), // Store complex object as string
      collectedData: JSON.stringify(collectedData), // Store inputs as string
      strategy: generatedPlan.strategy,
      title: generatedPlan.summary.title,
      createdAt: serverTimestamp(),
    });

    console.log("Plan saved with ID: ", docRef.id);
    showNotification(
      "Plan Saved",
      "The distribution plan has been saved and is accessible to other users.",
    );
  } catch (error) {
    console.error("Error saving plan: ", error);
    showErrorModal("Save Error", `Failed to save plan: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save Plan to Shared DB";
  }
}

/**
 * Listens for real-time updates to saved plans.
 */
function listenForPlans() {
  if (!db || !appId || firebaseConfig.projectId === "YOUR_PROJECT_ID") {
    console.warn("Firestore not ready, skipping plan listener.");
    document.getElementById("saved-plans-list").innerHTML =
      '<p class="text-gray-500">Connect Firebase to see saved plans.</p>';
    return;
  }

  const collectionPath = `artifacts/${appId}/public/data/plans`;
  const q = collection(db, collectionPath);

  // onSnapshot attaches a real-time listener
  onSnapshot(
    q,
    (querySnapshot) => {
      const savedPlansList = document.getElementById("saved-plans-list");
      savedPlansList.innerHTML = ""; // Clear list
      if (querySnapshot.empty) {
        savedPlansList.innerHTML =
          '<p class="text-gray-500">No saved plans found.</p>';
        return;
      }

      querySnapshot.forEach((doc) => {
        const plan = doc.data();
        const el = document.createElement("div");
        el.className =
          "p-3 bg-gray-700 rounded-lg shadow cursor-pointer hover:bg-gray-600";
        el.innerHTML = `
                 <h4 class="font-semibold text-blue-300">${plan.title || "Untitled Plan"}</h4>
                 <p class="text-sm text-gray-400">Strategy: ${plan.strategy}</p>
                 <p class="text-xs text-gray-500">Saved by: ${plan.userId.substring(0, 10)}...</p>
             `;
        // Add click event to load the plan
        el.onclick = () => {
          try {
            const planData = JSON.parse(plan.planData);
            const collData = JSON.parse(plan.collectedData);

            // Load data and render the plan
            generatedPlan = planData;
            collectedData = collData;
            renderPlan(planData);
            showPage("plan-page");
            showNotification(
              "Plan Loaded",
              `Loaded plan: ${planData.summary.title}`,
            );
          } catch (e) {
            console.error("Error parsing saved plan:", e);
            showErrorModal(
              "Load Error",
              "Could not parse the saved plan. The data might be corrupted.",
            );
          }
        };
        savedPlansList.appendChild(el);
      });
    },
    (error) => {
      console.error("Error listening to plans:", error);
      showErrorModal(
        "Load Error",
        "Could not load saved plans. See console for details.",
      );
    },
  );
}

// --- UI Utility Functions ---

/**
 * Shows a floating notification toast.
 * @param {string} title - The title of the notification.
 * @param {string} message - The body text of the notification.
 */
function showNotification(title, message) {
  const container = document.getElementById("notification-container");
  const id = `notif-${Date.now()}`;
  const el = document.createElement("div");
  el.id = id;
  el.className =
    "bg-gray-800 border border-blue-500 text-white p-4 rounded-lg shadow-xl animate-pulse"; // Simple pulse
  el.innerHTML = `
         <div class="flex justify-between items-center mb-2">
             <h4 class="font-bold text-blue-400">${title}</h4>
             <button class="text-gray-500 hover:text-white" onclick="document.getElementById('${id}').remove()">&times;</button>
         </div>
         <p>${message}</p>
     `;
  container.appendChild(el);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    el.remove();
  }, 5000);
}

/**
 * Shows a modal error dialog.
 * @param {string} title - The title of the error.
 * @param {string} message - The body text of the error.
 */
function showErrorModal(title, message) {
  document.getElementById("error-title").textContent = title;
  document.getElementById("error-message").textContent = message;
  document.getElementById("error-modal").classList.remove("hidden");
}

// --- Window Load and Event Listeners ---
window.onload = () => {
  // Page navigation
  document.getElementById("start-analysis-btn").onclick = handleInitialAnalysis;
  document.getElementById("send-chat-btn").onclick = handleUserMessage;
  document.getElementById("chat-input").onkeydown = (e) => {
    if (e.key === "Enter") handleUserMessage();
  };

  // Strategy buttons
  document.getElementById("btn-strategy-welfare").onclick = () =>
    showConfirmationPage("welfare");
  document.getElementById("btn-strategy-need").onclick = () =>
    showConfirmationPage("need");
  document.getElementById("btn-strategy-fastest").onclick = () =>
    showConfirmationPage("fastest");

  // Confirmation page buttons
  document.getElementById("confirm-and-generate-btn").onclick =
    generateFinalPlan;
  document.getElementById("back-to-strategy-btn").onclick = () =>
    showPage("optimization-page");

  // Plan page buttons
  document.getElementById("save-plan-btn").onclick = savePlan;
  document.getElementById("start-over-btn").onclick = () => {
    // Reset all state
    chatHistory = [];
    dynamicQuestions = [];
    currentQuestionIndex = 0;
    collectedData = {};
    generatedPlan = null;
    document.getElementById("chat-messages").innerHTML = "";
    document.getElementById("crisis-description").value = "";
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    showPage("entry-page");
  };

  // Error modal close
  document.getElementById("close-error-modal-btn").onclick = () => {
    document.getElementById("error-modal").classList.add("hidden");
  };

  // Sidebar toggle
  const sidebar = document.getElementById("sidebar");
  document.getElementById("toggle-sidebar-btn").onclick = () => {
    sidebar.classList.toggle("-translate-x-full");
  };

  // Initial setup
  showPage("entry-page");
  lucide.createIcons();
  console.log("Alloc8 App Initialized.");
};
