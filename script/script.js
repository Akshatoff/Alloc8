import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
    getAuth,
    signInAnonymously,
    signInWithCustomToken,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    addDoc,
    setDoc,
    collection,
    setLogLevel
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Global State ---
let db;
let auth;
let userId = null;
let appId = 'default-app-id';
let dynamicQuestions = [];
let currentQuestionIndex = 0;
let chatHistory = [];
let collectedData = {};
let generatedPlan = null;
let mapInstance = null;
const apiKey = "AIzaSyBP9Fkxfo0pzHARRLj6bK_qzTj9v3672o4"; // Leave as-is, Canvas will provide it

// --- Firebase Config and Init ---
// ATTENTION: Paste your own Firebase project configuration here!
// 1. Go to https://firebase.google.com/
// 2. Create a new project.
// 3. Add a "Web" app to your project.
// 4. Firebase will give you a 'firebaseConfig' object. Paste it here.
const firebaseConfig = {
  apiKey: "AIzaSyBhliGUFEJ7QiVwTAUXAsL-Tv4GNFZPATQ",
  authDomain: "alloc8-fc09f.firebaseapp.com",
  projectId: "alloc8-fc09f",
  storageBucket: "alloc8-fc09f.firebasestorage.app",
  messagingSenderId: "938509665123",
  appId: "1:938509665123:web:0d83ce05eb59e3cf604956",
  measurementId: "G-051ELH05LR"
};
// If your config is empty, the app will not connect to Firestore.
if (firebaseConfig.projectId === "YOUR_PROJECT_ID") {
    console.warn("Firebase config is not set. Please paste your project config in alloc8.html. Firestore features will not work.");
}

appId = firebaseConfig.projectId || 'alloc8-demo';

const app = initializeApp(firebaseConfig);
db = getFirestore(app);
auth = getAuth(app);
setLogLevel('debug');

// --- Auth Management ---
onAuthStateChanged(auth, async (user) => {
    if (user) {
        userId = user.uid;
        console.log("User authenticated:", userId);
        document.getElementById('user-id-display').textContent = `User ID: ${userId}`;
    } else {
        try {
            if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                await signInWithCustomToken(auth, __initial_auth_token);
            } else {
                await signInAnonymously(auth);
            }
        } catch (error) {
            console.error("Anonymous Sign-In Error:", error);
            userId = `anon-${crypto.randomUUID()}`;
            document.getElementById('user-id-display').textContent = `User ID: ${userId} (Offline)`;
        }
    }
});

// --- Utility Functions ---

/**
 * Exponential backoff for API calls.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calls the Gemini API with exponential backoff.
 * @param {object} payload - The payload to send to the API.
 * @param {boolean} useGrounding - Whether to use Google Search grounding.
 * @returns {Promise<object>} - The API response.
 */
async function callGeminiAPI(payload, useGrounding = false, retries = 5, baseDelay = 1000) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    if (useGrounding) {
        payload.tools = [{ "google_search": {} }];
    }

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];

            if (candidate && candidate.content?.parts?.[0]?.text) {
                let sources = [];
                const groundingMetadata = candidate.groundingMetadata;
                if (useGrounding && groundingMetadata && groundingMetadata.groundingAttributions) {
                    sources = groundingMetadata.groundingAttributions
                        .map(attr => ({
                            uri: attr.web?.uri,
                            title: attr.web?.title,
                        }))
                        .filter(source => source.uri && source.title);
                }
                return { text: candidate.content.parts[0].text, sources };
            } else {
                throw new Error("Invalid API response structure.");
            }
        } catch (error) {
            console.warn(`API call failed (attempt ${i + 1}/${retries}): ${error.message}`);
            if (i === retries - 1) {
                throw error; // Rethrow last error
            }
            await delay(baseDelay * Math.pow(2, i)); // Exponential backoff
        }
    }
}

/**
 * Shows a specific page/section by ID and hides others.
 * @param {string} pageId - The ID of the page to show.
 */
function showPage(pageId) {
    const pages = document.querySelectorAll('.page-section');
    pages.forEach(page => {
        page.classList.toggle('hidden', page.id !== pageId);
    });
    // Special handling for plan page to trigger map resize
    if (pageId === 'plan-page' && mapInstance) {
        setTimeout(() => mapInstance.invalidateSize(), 100);
    }
}

/**
 * Toggles the main loader.
 * @param {boolean} isLoading - Whether to show the loader.
 */
function showLoader(isLoading) {
    document.getElementById('main-loader').classList.toggle('hidden', !isLoading);
    document.getElementById('main-content').classList.toggle('hidden', isLoading);
}

/**
 * Adds a message to the chat UI.
 * @param {string} text - The message text.
 * @param {string} type - 'user', 'ai', or 'system'.
 * @param {Array<object>} [sources] - Optional array of source objects.
 */
function addChatMessage(text, type, sources = []) {
    const chatLog = document.getElementById('chat-log');
    const bubble = document.createElement('div');
    bubble.classList.add('chat-bubble', `chat-bubble-${type}`);

    let htmlContent = text.replace(/\n/g, '<br>');

    if (sources.length > 0) {
        htmlContent += '<br><br><strong>Augmented Data Sources:</strong><ul>';
        sources.forEach((source, index) => {
            htmlContent += `<li class="truncate ml-4 list-disc"><a href="${source.uri}" target="_blank" class="text-blue-300 hover:underline">${index + 1}. ${source.title}</a></li>`;
        });
        htmlContent += '</ul>';
    }

    bubble.innerHTML = htmlContent;
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
}

// --- App Logic Functions ---

/**
 * Handles the initial analysis request.
 */
async function handleInitialAnalysis() {
    const initialPrompt = document.getElementById('crisis-description').value;
    if (!initialPrompt) {
        alert("Please describe the crisis situation."); // Using custom modal later
        return;
    }

    showPage('chat-page');
    document.getElementById('chat-input-container').classList.add('hidden');
    addChatMessage(initialPrompt, 'user');
    collectedData['initial_description'] = initialPrompt;

    // Add to chat history for context
    chatHistory.push({ role: "user", parts: [{ text: initialPrompt }] });

    // 1. Fetch Grounded Data
    addChatMessage("Analyzing situation and augmenting with real-time data...", 'ai');
    try {
        const systemPromptGrounding = "You are a humanitarian crisis analyst. Based on the user's report, provide a concise one-paragraph summary of the situation, augmented with key facts from your search (like population, geography, or recent events). Cite your sources.";
        const payloadGrounding = {
            contents: [{ parts: [{ text: initialPrompt }] }],
            systemInstruction: { parts: [{ text: systemPromptGrounding }] }
        };
        const groundedData = await callGeminiAPI(payloadGrounding, true);
        addChatMessage(groundedData.text, 'system', groundedData.sources);
        collectedData['grounded_summary'] = groundedData.text;
        collectedData['sources'] = groundedData.sources;
    } catch (error) {
        console.error("Grounding API Error:", error);
        addChatMessage("Could not fetch real-time data. Proceeding with provided information.", 'system');
    }

    // 2. Fetch Dynamic Questions
    addChatMessage("Formulating follow-up questions...", 'ai');
    try {
        const systemPromptQuestions = `You are an AI assistant for humanitarian logistics. Your goal is to gather critical data. The user has provided an initial report. Ask 3-4 essential follow-up questions one by one to clarify: 1. Specific locations (cities, regions). 2. Estimated population affected. 3. Priority needs (e.g., water, food, medical). 4. Available transport/logistics routes. Return ONLY a JSON array of strings, where each string is a question. Example: ["Question 1?", "Question 2?"]`;

        const payloadQuestions = {
            contents: chatHistory, // Send history for context
            systemInstruction: { parts: [{ text: systemPromptQuestions }] }
        };
        const questionData = await callGeminiAPI(payloadQuestions, false);

        // Clean the response text to remove markdown fences
        let cleanedJsonText = questionData.text.trim();
        const jsonRegex = /```json\s*([\s\S]*?)\s*```|([\s\S]*)/;
        const match = cleanedJsonText.match(jsonRegex);

        if (match && match[1]) {
            cleanedJsonText = match[1]; // Use content from ```json block
        } else if (match && match[2]) {
            cleanedJsonText = match[2]; // Use the whole string if no fences
        }

        // Parse the JSON array of questions
        dynamicQuestions = JSON.parse(cleanedJsonText.trim());
        currentQuestionIndex = 0;

        // Ask the first question
        if (dynamicQuestions.length > 0) {
            addChatMessage(dynamicQuestions[currentQuestionIndex], 'ai');
            document.getElementById('chat-input-container').classList.remove('hidden');
        } else {
            finishDataCollection();
        }
    } catch (error) {
        console.error("Question Generation API Error:", error);
        addChatMessage("Could not generate dynamic questions. Proceeding to parameter selection.", 'ai');
        finishDataCollection();
    }
}

/**
 * Handles the user's response in the chat.
 */
function handleChatResponse() {
    const chatInput = document.getElementById('chat-input');
    const response = chatInput.value;
    if (!response) return;

    addChatMessage(response, 'user');

    // Save the answer
    const currentQuestion = dynamicQuestions[currentQuestionIndex];
    collectedData[currentQuestion] = response;

    // Add to chat history
    chatHistory.push({ role: "user", parts: [{ text: response }] });

    currentQuestionIndex++;
    chatInput.value = '';

    if (currentQuestionIndex < dynamicQuestions.length) {
        // Ask the next question
        addChatMessage(dynamicQuestions[currentQuestionIndex], 'ai');
    } else {
        // All questions asked
        finishDataCollection();
    }
}

/**
 * Moves from chat to optimization parameters.
 */
function finishDataCollection() {
    addChatMessage("Data collection complete. Please proceed to select your optimization strategy.", 'ai');
    document.getElementById('chat-input-container').classList.add('hidden');
    document.getElementById('proceed-to-params-btn').classList.remove('hidden');
}

/**
 * Simulates plan generation and displays it.
 */
function handleGeneratePlan() {
    const optimizationStrategy = document.querySelector('input[name="strategy"]:checked').value;
    collectedData['strategy'] = optimizationStrategy;

    showPage('plan-page');
    document.getElementById('plan-loader').classList.remove('hidden');
    document.getElementById('plan-output').classList.add('hidden');

    // --- SIMULATION LOGIC ---
    // In a real app, this would be a complex backend call.
    // Here, we just simulate the output based on the strategy.
    setTimeout(() => {
        generatedPlan = simulatePlan(optimizationStrategy);
        displayPlan(generatedPlan);
        document.getElementById('plan-loader').classList.add('hidden');
        document.getElementById('plan-output').classList.remove('hidden');
    }, 2000); // Simulate processing time
}

/**
 * Simulates a plan object.
 * @param {string} strategy - The chosen strategy.
 * @returns {object} - A simulated plan object.
 */
function simulatePlan(strategy) {
    let plan = {
        strategy: strategy,
        summary: {},
        ledger: [],
        mapData: {
            center: [28.6139, 77.2090], // Default: New Delhi
            hub: [28.6139, 77.2090],
            locations: [
                { name: "Location A", coords: [28.6339, 77.2290] },
                { name: "Location B", coords: [28.5939, 77.1890] },
                { name: "Location C", coords: [28.6139, 77.1790] },
            ]
        }
    };

    // Try to find a location from chat to center the map
    const locationAnswer = collectedData[dynamicQuestions[0]]; // Assuming first question was about location
    if (locationAnswer) {
        // This is a placeholder. A real app would geocode this.
        // For demo, we'll just keep the default.
        console.log("Geocoding location (simulated):", locationAnswer);
    }

    // Adjust plan based on strategy
    if (strategy === 'fastest') {
        plan.summary = {
            time: "28 Hours (Simulated)",
            landTravel: "150 km (Air-priority)",
            airTravel: "1200 km (Direct flights)"
        };
        plan.ledger = [
            { loc: "Location A", res: "High-Energy Rations", qty: 5000 },
            { loc: "Location B", res: "Water Purification Tabs", qty: 10000 },
            { loc: "Location C", res: "First-Aid Kits", qty: 300 },
        ];
    } else if (strategy === 'max_welfare') {
        plan.summary = {
            time: "72 Hours (Simulated)",
            landTravel: "650 km (Full coverage)",
            airTravel: "800 km (Supply drops)"
        };
        plan.ledger = [
            { loc: "Location A", res: "Food Rations", qty: 10000 },
            { loc: "Location A", res: "Water (Liters)", qty: 20000 },
            { loc: "Location A", res: "Tents", qty: 500 },
            { loc: "Location B", res: "Medical Kits", qty: 1000 },
            { loc: "Location B", res: "Water (Liters)", qty: 15000 },
            { loc: "Location C", res: "Food Rations", qty: 8000 },
            { loc: "Location C", res: "Blankets", qty: 2000 },
        ];
    } else { // most_need
        plan.summary = {
            time: "48 Hours (Simulated)",
            landTravel: "400 km (Targeted)",
            airTravel: "900 km (Medevac/Specialist)"
        };
        plan.ledger = [
            { loc: "Location A", res: "Critical Medical Supplies", qty: 2000 },
            { loc: "Location A", res: "Water (Liters)", qty: 10000 },
            { loc: "Location B", res: "Food Rations", qty: 8000 },
            { loc: "Location C", res: "Medical Kits", qty: 800 },
            { loc: "Location C", res: "Water (Liters)", qty: 5000 },
        ];
    }
    return plan;
}

/**
 * Renders the generated plan to the UI.
 * @param {object} plan - The simulated plan object.
 */
function displayPlan(plan) {
    // Display Summary
    document.getElementById('plan-strategy').textContent = `Strategy: ${plan.strategy.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}`;
    document.getElementById('plan-time').textContent = plan.summary.time;
    document.getElementById('plan-land').textContent = plan.summary.landTravel;
    document.getElementById('plan-air').textContent = plan.summary.airTravel;

    // Display Ledger
    const ledgerBody = document.getElementById('ledger-body');
    ledgerBody.innerHTML = ''; // Clear old data
    plan.ledger.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="py-3 px-4 text-sm text-gray-300">${item.loc}</td>
            <td class="py-3 px-4 text-sm text-gray-300">${item.res}</td>
            <td class="py-3 px-4 text-sm text-gray-300 text-right">${item.qty.toLocaleString()}</td>
        `;
        ledgerBody.appendChild(row);
    });

    // Display Map
    if (mapInstance) {
        mapInstance.remove();
    }
    mapInstance = L.map('map').setView(plan.mapData.center, 10);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(mapInstance);

    // Add Hub
    L.marker(plan.mapData.hub, {
        icon: L.divIcon({
            className: 'custom-div-icon',
            html: `<i data-lucide="home" class="text-blue-400" style="width:32px; height:32px;"></i>`,
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        })
    }).addTo(mapInstance).bindPopup("Distribution Hub");

    // Add Locations and Routes
    plan.mapData.locations.forEach(loc => {
        L.marker(loc.coords, {
            icon: L.divIcon({
                className: 'custom-div-icon',
                html: `<i data-lucide="map-pin" class="text-red-500" style="width:32px; height:32px;"></i>`,
                iconSize: [32, 32],
                iconAnchor: [16, 32]
            })
        }).addTo(mapInstance).bindPopup(loc.name);

        // Draw route line
        L.polyline([plan.mapData.hub, loc.coords], {
            color: 'rgba(59, 130, 246, 0.7)', // blue-500
            weight: 3,
            dashArray: '5, 5'
        }).addTo(mapInstance);
    });

    lucide.createIcons(); // Render new icons on map
}

/**
 * Saves the current plan to Firestore.
 */
async function savePlan() {
    if (!generatedPlan || !userId || !db) {
        alert("No plan generated or database not ready.");
        return;
    }

    const saveButton = document.getElementById('save-plan-btn');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        // We store public plans under a common collection
        const planCollectionPath = `/artifacts/${appId}/public/data/plans`;
        const planDoc = {
            ...generatedPlan,
            createdBy: userId,
            createdAt: new Date().toISOString(),
            collectedData: collectedData // Save the inputs that led to the plan
        };

        const docRef = await addDoc(collection(db, planCollectionPath), planDoc);
        console.log("Plan saved with ID:", docRef.id);
        document.getElementById('plan-id-display').textContent = `Plan ID: ${docRef.id}`;
        saveButton.textContent = 'Plan Saved!';
        saveButton.classList.remove('bg-blue-600', 'hover:bg-blue-700');
        saveButton.classList.add('bg-green-600');

    } catch (error) {
        console.error("Error saving plan:", error);
        alert("Error saving plan. Check console for details.");
        saveButton.disabled = false;
        saveButton.textContent = 'Save Plan';
    }
}

// --- Event Listeners ---
window.onload = () => {
    lucide.createIcons();
    showLoader(true);

    // Simulate auth/init time
    setTimeout(() => {
        showLoader(false);
        showPage('input-page');
    }, 1500);

    document.getElementById('start-analysis-btn').addEventListener('click', handleInitialAnalysis);
    document.getElementById('chat-send-btn').addEventListener('click', handleChatResponse);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleChatResponse();
    });
    document.getElementById('proceed-to-params-btn').addEventListener('click', () => showPage('params-page'));
    document.getElementById('generate-plan-btn').addEventListener('click', handleGeneratePlan);
    document.getElementById('save-plan-btn').addEventListener('click', savePlan);
};
