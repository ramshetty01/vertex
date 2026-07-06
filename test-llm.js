require("dotenv").config();
const OpenAI = require("openai");
const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
  timeout: 30000,
});

(async () => {
  console.time("llm");
  const r = await client.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [{ role: "user", content: "Say OK" }],
    max_tokens: 5,
  });
  console.timeEnd("llm");
  console.log("Response:", r.choices[0].message.content);
})();