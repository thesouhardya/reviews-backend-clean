// netlify/functions/addReview.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// ✅ CORRECTED: Use stable v1 API with proper model name
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent";

// Define JSON schema for structured output
const REVIEW_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    safety_score: {
      type: "number",
      description: "Safety score between 0 (safe) and 1 (unsafe)",
      minimum: 0,
      maximum: 1
    },
    sentiment_score: {
      type: "number",
      description: "Sentiment score between -1 (negative) and 1 (positive)",
      minimum: -1,
      maximum: 1
    },
    action: {
      type: "string",
      description: "Recommended action for the review",
      enum: ["allow", "flag", "block"]
    }
  },
  required: ["safety_score", "sentiment_score", "action"]
};

// Helper to safely parse JSON
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ✅ CORRECTED: Use default export with new handler signature
export default async function handler(request, context) {
  try {
    // Only allow POST
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Parse body (from Framer)
    const body = await request.json();
    const { business_id, reviewer_name, phone, content } = body;

    if (!business_id || !reviewer_name || !phone || !content) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Optional: verify secret header
    const secret = request.headers.get("x-webhook-secret");
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return new Response(
        JSON.stringify({ error: "Invalid webhook secret" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 1️⃣ Call Gemini API with structured output
    const prompt = `Analyze the following customer review and classify it based on safety and sentiment.

Review Content: "${content}"

Provide:
1. A safety_score (0 = completely safe, 1 = extremely unsafe/harmful)
2. A sentiment_score (-1 = very negative, 0 = neutral, 1 = very positive)
3. An action recommendation:
   - "allow": Safe, constructive review (safety < 0.3)
   - "flag": Needs manual review (safety 0.3-0.7 or borderline sentiment)
   - "block": Unsafe, spam, or highly inappropriate (safety >= 0.7)

Consider:
- Profanity, hate speech, threats, or harassment (increase safety_score)
- Spam or promotional content (increase safety_score)
- Overall tone: positive, neutral, or negative (affects sentiment_score)
- Constructive criticism is allowed (low safety_score, may be negative sentiment)`;

    console.log("Calling Gemini API with structured output...");

    // ✅ USE STRUCTURED OUTPUT with responseMimeType and responseSchema
    const geminiResponse = await fetch(
      `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: REVIEW_ANALYSIS_SCHEMA
          }
        }),
      }
    );

    const geminiData = await geminiResponse.json();
    
    // Check for API errors
    if (geminiData.error) {
      console.error("Gemini API error:", geminiData.error);
      return new Response(
        JSON.stringify({ error: `Gemini API error: ${geminiData.error.message}` }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const modelText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    console.log("Gemini structured output:", modelText);

    // Parse the structured JSON response
    const result = safeJSON(modelText) || {};
    const safety = result.safety_score ?? 0.5; // Default to flag if parsing fails
    const sentiment = result.sentiment_score ?? 0;
    const action = result.action ?? "flag";

    console.log(`Analysis: safety=${safety}, sentiment=${sentiment}, action=${action}`);

    // 2️⃣ Determine status based on Gemini's recommendation
    let status = "pending";
    if (action === "allow" && safety < 0.3) {
      status = "approved";
    } else if (action === "block" || safety >= 0.7) {
      status = "flagged";
    } else {
      status = "pending"; // Requires manual review
    }

    // 3️⃣ Insert into Supabase
    const { error: insertError } = await supabase.from("reviews").insert([
      {
        business_id,
        reviewer_name,
        phone,
        content,
        status,
        sentiment_score: sentiment,
        is_positive: sentiment > 0,
      },
    ]);

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return new Response(
        JSON.stringify({ error: insertError.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 4️⃣ Return success with analysis details
    return new Response(
      JSON.stringify({
        ok: true,
        message: "Review received and analyzed successfully.",
        status,
        analysis: {
          safety_score: safety,
          sentiment_score: sentiment,
          recommended_action: action
        }
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Server error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
