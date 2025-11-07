// netlify/functions/autoPinTopReviews.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

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

    const body = await request.json();
    const { business_id } = body;

    if (!business_id) {
      return new Response(
        JSON.stringify({ error: "business_id is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 1️⃣ Fetch all approved reviews for this business
    const { data: reviews, error: fetchError } = await supabase
      .from("reviews")
      .select("*")
      .eq("business_id", business_id)
      .eq("status", "approved");

    if (fetchError) {
      console.error("Fetch error:", fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!reviews || reviews.length === 0) {
      return new Response(
        JSON.stringify({ 
          ok: true, 
          message: "No reviews to analyze",
          pinnedCount: 0 
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 2️⃣ Prepare reviews for Gemini analysis
    const reviewsForAnalysis = reviews.map(r => ({
      id: r.id,
      content: r.content,
      reviewer_name: r.reviewer_name,
      sentiment_score: r.sentiment_score
    }));

    // 3️⃣ Ask Gemini to select top 3 reviews
    const prompt = `You are a review quality analyzer. Analyze these customer reviews and identify the TOP 3 BEST reviews that should be pinned/highlighted.

Criteria for "best" reviews:
- High quality, detailed feedback
- Specific examples or descriptions
- Positive sentiment and helpfulness
- Well-written and authentic
- Most valuable for potential customers

Reviews to analyze:
${JSON.stringify(reviewsForAnalysis, null, 2)}

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{
  "top_review_ids": [id1, id2, id3],
  "reasoning": "Brief explanation of why these 3 were chosen"
}

IMPORTANT: Return exactly 3 review IDs (or fewer if less than 3 reviews exist). Use the actual review IDs from the data provided.`;

    console.log("Calling Gemini API for top reviews analysis...");
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

    const result = safeJSON(cleanText) || {};
    const topReviewIds = result.top_review_ids || [];

    console.log("Top review IDs selected by Gemini:", topReviewIds);
    console.log("Reasoning:", result.reasoning);

    // 4️⃣ Unpin all reviews first
    const { error: unpinError } = await supabase
      .from("reviews")
      .update({ pinned: false })
      .eq("business_id", business_id);

    if (unpinError) {
      console.error("Unpin error:", unpinError);
    }

    // 5️⃣ Pin the top 3 reviews
    if (topReviewIds.length > 0) {
      const { error: pinError } = await supabase
        .from("reviews")
        .update({ pinned: true })
        .in("id", topReviewIds);

      if (pinError) {
        console.error("Pin error:", pinError);
        return new Response(
          JSON.stringify({ error: pinError.message }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // 6️⃣ Return success
    return new Response(
      JSON.stringify({
        ok: true,
        message: "Top reviews pinned successfully",
        pinnedCount: topReviewIds.length,
        pinnedReviewIds: topReviewIds,
        reasoning: result.reasoning
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
