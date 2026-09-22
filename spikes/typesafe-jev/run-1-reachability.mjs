// Probe 1: can we reach the API from Node, and what do the CORS headers say about a browser?
import { apiKey, API } from "./env.mjs";

const key = apiKey();

const body = {
  state: "Help! My payouts have been failing for 3 days.",
  model: "jev-latest",
  questions: {
    is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
      },
    },
  },
};

const t0 = Date.now();
const res = await fetch(API, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const ms = Date.now() - t0;
const text = await res.text();
console.log(`POST ${res.status} in ${ms}ms`);
console.log("response:", text.slice(0, 1200));

// What would a browser see? Simulate the preflight a browser sends before a cross-origin
// POST carrying an Authorization header.
const pre = await fetch(API, {
  method: "OPTIONS",
  headers: {
    Origin: "http://localhost:5173",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type",
  },
});
console.log(`\nOPTIONS preflight ${pre.status}`);
let sawCors = false;
for (const [k, v] of pre.headers) {
  if (/^access-control|^vary/i.test(k)) {
    console.log(`  ${k}: ${v}`);
    sawCors = true;
  }
}
if (!sawCors) console.log("  (no access-control-* headers returned)");
