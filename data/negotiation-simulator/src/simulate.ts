#!/usr/bin/env npx tsx
const EXECUTION_URL = process.env.EXECUTION_URL || "http://localhost:8083";

type TranscriptTurn = { role: "agent" | "debtor"; text: string };

type NegotiateResponse = {
  agentReply: string;
  resolved: boolean;
  outcome?: string;
  promisedDate?: string;
  turnNumber: number;
  maxTurns: number;
};

// Scripted debtor personas — each is an array of messages in order.
// The simulator feeds them one by one as the debtor's turn.
const PERSONAS: Record<string, { description: string; messages: string[] }> = {
  cooperative: {
    description: "Agrees to pay after one follow-up",
    messages: [
      "Haan bhaiya, sun raha hoon. Kya hua?",
      "Accha, payment pending hai? Theek hai, abhi kar deta hoon.",
    ],
  },
  evasive: {
    description: "Stalls, eventually gives a date",
    messages: [
      "Haan haan, pata hai. Abhi busy hoon.",
      "Next week kar dunga, pakka.",
      "Friday tak ho jayega, tension mat lo.",
    ],
  },
  hostile: {
    description: "Rude and aggressive — agent should escalate gracefully",
    messages: [
      "Tum log har roz call karte ho! Bahut pareshan kar diya!",
      "Nahi dunga payment, jo karna hai kar lo!",
      "Block karo mere ko, mujhe koi farak nahi padta!",
    ],
  },
  cant_pay: {
    description: "Clearly can't pay — agent accepts gracefully",
    messages: [
      "Bhai meri situation bahut kharab hai.",
      "Account mein bilkul balance nahi hai. Job bhi gayi hai.",
      "Kuch nahi kar sakta abhi, maaf karo.",
    ],
  },
  stall_then_pay: {
    description: "Stalls for several turns then commits to a date",
    messages: [
      "Hmm, dekhte hain.",
      "Abhi nahi ho payega.",
      "Kal tak soch ke batata hoon.",
      "Theek hai bhai, 15 September tak kar dunga. Pakka.",
    ],
  },
};

async function runNegotiation(
  personaName: string,
  persona: { description: string; messages: string[] },
  context: {
    customerId: string;
    orderId: string;
    amountPaise: number;
    rootCauseNarrative: string;
    escalationCount: number;
  },
): Promise<{ turns: number; outcome: string; transcript: TranscriptTurn[] }> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PERSONA: ${personaName} — ${persona.description}`);
  console.log(`${"=".repeat(60)}\n`);

  const transcript: TranscriptTurn[] = [];
  let resolved = false;
  let outcome = "escalate";
  let messageIndex = 0;

  // Get opening line
  const openResp = await fetch(`${EXECUTION_URL}/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionContext: context,
      transcript: [],
      debtorMessage: "",
    }),
  });

  if (!openResp.ok) {
    throw new Error(`negotiate failed: ${openResp.status} ${await openResp.text()}`);
  }

  const openResult = (await openResp.json()) as NegotiateResponse;
  transcript.push({ role: "agent", text: openResult.agentReply });
  console.log(`[Agent]: ${openResult.agentReply}\n`);

  if (openResult.resolved) {
    return { turns: 1, outcome: openResult.outcome ?? "unknown", transcript };
  }

  // Play turns
  while (!resolved && messageIndex < persona.messages.length) {
    const debtorMsg = persona.messages[messageIndex];
    messageIndex++;

    console.log(`[Debtor]: ${debtorMsg}\n`);

    const resp = await fetch(`${EXECUTION_URL}/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionContext: context,
        transcript,
        debtorMessage: debtorMsg,
      }),
    });

    if (!resp.ok) {
      throw new Error(`negotiate failed: ${resp.status} ${await resp.text()}`);
    }

    const result = (await resp.json()) as NegotiateResponse;
    transcript.push({ role: "debtor", text: debtorMsg });
    transcript.push({ role: "agent", text: result.agentReply });

    console.log(`[Agent]: ${result.agentReply}\n`);

    if (result.resolved) {
      resolved = true;
      outcome = result.outcome ?? "escalate";
      console.log(`✅ RESOLVED: ${outcome}${result.promisedDate ? ` (date: ${result.promisedDate})` : ""}`);
    }
  }

  if (!resolved) {
    console.log(`⚠️  Persona messages exhausted without resolution — agent would escalate`);
  }

  return { turns: transcript.length, outcome, transcript };
}

async function main() {
  const personaArg = process.argv.find((a) => a.startsWith("--persona="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--persona") + 1];

  const personas = personaArg
    ? { [personaArg]: PERSONAS[personaArg] }
    : PERSONAS;

  if (personaArg && !PERSONAS[personaArg]) {
    console.error(`Unknown persona: ${personaArg}. Available: ${Object.keys(PERSONAS).join(", ")}`);
    process.exit(1);
  }

  const context = {
    customerId: "cust_sim_neg_001",
    orderId: "ord_sim_neg_001",
    amountPaise: 500000, // ₹5,000
    rootCauseNarrative: "Payment failed due to insufficient funds on the customer's card",
    escalationCount: 0,
  };

  console.log("Phase 7 — Automated Negotiation Simulator");
  console.log(`Testing against: ${EXECUTION_URL}`);
  console.log(`Context: Order ${context.orderId}, ${new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(context.amountPaise)}`);

  const results: Array<{ persona: string; turns: number; outcome: string }> = [];

  for (const [name, persona] of Object.entries(personas)) {
    try {
      const result = await runNegotiation(name, persona, context);
      results.push({ persona: name, turns: result.turns, outcome: result.outcome });
    } catch (err: any) {
      console.error(`❌ ${name} FAILED: ${err?.message}`);
      results.push({ persona: name, turns: 0, outcome: "error" });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("RESULTS SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.log(`${"Persona".padEnd(20)} ${"Turns".padEnd(8)} Outcome`);
  console.log("-".repeat(45));
  for (const r of results) {
    console.log(`${r.persona.padEnd(20)} ${String(r.turns).padEnd(8)} ${r.outcome}`);
  }

  // Verify turn limit enforcement
  const longRuns = results.filter((r) => r.turns > 16); // 8 turns × 2 (agent+debtor) = 16
  if (longRuns.length > 0) {
    console.log(`\n⚠️  WARNING: ${longRuns.length} personas exceeded 8-turn limit!`);
  } else {
    console.log(`\n✅ All personas stayed within the 8-turn limit.`);
  }
}

main().catch((err) => {
  console.error("Simulator failed:", err);
  process.exit(1);
});
