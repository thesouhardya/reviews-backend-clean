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
    const { business_id, reviewer_name, phone, email, content } = body;

    if (!business_id || !reviewer_name || !phone || !content) {      return new Response(
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

    // 1️⃣ Call Gemini API
    const prompt = `You are a strict JSON-only classifier. Analyze this customer review and respond ONLY with a valid JSON object.

Review Content: "${content}"

Respond with a JSON object in this exact format (no markdown, no code blocks, just pure JSON):
{
  "safety_score": <number between 0 and 1>,
  "sentiment_score": <number between -1 and 1>,
  "action": "allow" or "flag" or "block"
}

Guidelines:
- safety_score: 0 = completely safe, 1 = extremely unsafe/harmful
  * Increase for: profanity, hate speech, threats, harassment, spam
- sentiment_score: -1 = very negative, 0 = neutral, 1 = very positive
  * Based on overall tone and opinion expressed
- action recommendations:
  * "allow": Safe, constructive review (safety < 0.3)
  * "flag": Needs manual review (safety 0.3-0.7 or unclear)
  * "block": Unsafe, spam, or highly inappropriate (safety >= 0.7)

Important: Constructive criticism is allowed (low safety_score, may have negative sentiment).

Respond with ONLY the JSON object, nothing else.`;

    console.log("Calling Gemini API...");

    const geminiResponse = await fetch(
      `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
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
    console.log("Gemini raw output:", modelText);

    // Clean up markdown code blocks if present
    let cleanText = modelText.trim();
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    } else if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/```\n?/g, "");
    }

    // Parse the JSON response
    const result = safeJSON(cleanText) || {};
    const safety = result.safety_score ?? 0.5; // Default to flag if parsing fails
    const sentiment = result.sentiment_score ?? 0;
    const action = result.action ?? "flag";

    console.log(`Analysis: safety=${safety}, sentiment=${sentiment}, action=${action}`);

    // 2️⃣ Determine status based on Gemini's recommendation
    let status = "pending";
 if (action === "allow" && safety < 0.3 && sentiment > 0.3) {      status = "approved";
    } else if (action === "block" || safety >= 0.7) {
      status = "flagged";
    } else {
      status = "pending"; // Requires manual review
    }

    // 3️⃣ Insert into Supabase
    // Insert review and return inserted row (including ID) to frontend
  const { data: insertedReviews, error: insertError } = await supabase
    .from("reviews")
    .insert([
      {
        business_id,
        reviewer_name,
        phone,
                email,
        content,
        status,
        sentiment_score: sentiment,
        is_positive: sentiment > 0,
        pinned: false // default new reviews aren't pinned
      },
    ])
    .select(); // will return the inserted row including its ID

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
        },
      review: insertedReviews?.[0] || null
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
