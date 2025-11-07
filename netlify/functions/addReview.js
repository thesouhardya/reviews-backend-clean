// netlify/functions/addReview.js

import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/*
  Netlify function version of addReview:
  - Accepts POST requests from your Framer form
  - Uses Gemini API to check content
  - Inserts review into Supabase "reviews" table
*/

// Initialize Supabase client using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Gemini endpoint
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// Helper to safely parse JSON
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ✅ Netlify-style export
export async function handler(event) {
  try {
    // Only allow POST
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    // Parse body (from Framer)
    const body = JSON.parse(event.body || "{}");
    const { business_id, reviewer_name, phone, content } = body;

    if (!business_id || !reviewer_name || !phone || !content) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // Optional: verify secret header
    const secret = event.headers["x-webhook-secret"];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Invalid webhook secret" }),
      };
    }

    // 1️⃣ Call Gemini API
    const prompt = `
    Analyze this review for inappropriate or harmful content.
    Respond ONLY in this exact JSON structure:
    {
      "safety_score": number,
      "sentiment_score": number,
      "action": "allow" | "flag" | "block"
    }
    Review: "${content}"
    `;

    const geminiResponse = await fetch(
      `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );

    const geminiData = await geminiResponse.json();
    const modelText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    console.log("Gemini raw output:", JSON.stringify(geminiData, null, 2));
    const result = safeJSON(modelText) || {};

    const safety = result.safety_score ?? 0;
    const sentiment = result.sentiment_score ?? 0;
    const action = result.action ?? "flag";

    // 2️⃣ Determine status
    let status = "pending";
    if (action === "allow" && safety < 0.3) status = "approved";
    else if (action === "block" || safety >= 0.7) status = "flagged";

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
      return {
        statusCode: 500,
        body: JSON.stringify({ error: insertError.message }),
      };
    }

    // 4️⃣ Return success
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: "Review received successfully.",
        status,
      }),
    };
  } catch (err) {
    console.error("Server error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Internal error" }),
    };
  }
}
