// lib/llm.js — ONE shared LLM client for all agents (the seed of your LLM gateway)
// Every agent imports from here. When you add caching, retries, or switch
// providers later, you change this one file and nothing else.

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
  timeout: 120 * 1000, // 2 minutes per attempt
  maxRetries: 2,       // SDK auto-retries timeouts & 429s with backoff
});

// Model routing: pick the smallest model that does each job reliably.
// (You discovered this yourself: 8B was fast but inconsistent for parsing.)
const MODELS = {
  strong: "meta/llama-3.1-70b-instruct", // parsing, scoring, tailoring (3.3-70b NIM endpoint was down; 3.1-70b same class, alive)
  fast: "meta/llama-3.1-8b-instruct",    // intent classification, simple routing
};

/**
 * Call the LLM and get back validated JSON.
 * - systemPrompt: the instructions + schema
 * - userContent:  the data to process
 * - tier:         "strong" (default) or "fast"
 * Retries once on invalid JSON, then throws.
 */
async function completeJSON(systemPrompt, userContent, tier = "strong") {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: MODELS[tier],
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    const content = completion.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (_) {
        // fall through to retry
      }
    }
    console.warn(`⚠️ LLM returned invalid JSON (attempt ${attempt}/2)`);
  }
  throw new Error("LLM_INVALID_JSON");
}

/**
 * Raw completion — returns the model's text as-is. Use when an agent needs to do
 * its own (more tolerant) parsing, e.g. free-prose fields that break strict JSON.
 */
async function complete(systemPrompt, userContent, tier = "strong") {
  const completion = await client.chat.completions.create({
    model: MODELS[tier],
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return completion.choices[0].message.content || "";
}

module.exports = { completeJSON, complete, MODELS };