// Scheduled function to automatically pin top 3 reviews daily
// Runs at 3 AM IST every day (9:30 PM UTC previous day)
import { schedule } from "@netlify/functions";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase to get all business IDs
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// The main scheduled handler
const handler = async (event) => {
  console.log("🕒 Scheduled pin-top-reviews job started at:", new Date().toISOString());
  
  try {
    // Get all unique business IDs from reviews table
    const { data: businesses, error } = await supabase
      .from("reviews")
      .select("business_id")
      .eq("status", "approved");
    
    if (error) {
      console.error("Error fetching businesses:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message })
      };
    }
    
    // Get unique business IDs
    const uniqueBusinessIds = [...new Set(businesses.map(b => b.business_id))];
    console.log(`Found ${uniqueBusinessIds.length} businesses to process`);
    
    // Process each business
    const results = [];
    for (const business_id of uniqueBusinessIds) {
      console.log(`Processing business: ${business_id}`);
      
      // Call the autoPinTopReviews function internally
      const response = await fetch(
        `${process.env.URL}/.netlify/functions/autoPinTopReviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ business_id })
        }
      );
      
      const result = await response.json();
      results.push({
        business_id,
        success: response.ok,
        pinnedCount: result.pinnedCount || 0,
        reasoning: result.reasoning || "N/A"
      });
      
      console.log(`✅ Business ${business_id}: Pinned ${result.pinnedCount} reviews`);
    }
    
    console.log("🎉 Scheduled job completed successfully");
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Top reviews pinned successfully for all businesses",
        results
      })
    };
    
  } catch (err) {
    console.error("❌ Scheduled job error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};

// Schedule to run daily at 3 AM IST (9:30 PM UTC previous day)
// Cron format: minute hour day-of-month month day-of-week
export default schedule("30 21 * * *", handler);
