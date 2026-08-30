"use client";

import { useEffect, useState } from "react";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

type FeedItem = {
  eventId: string;
  eventType: string;
  orderId: string | null;
  customerId: string | null;
  amountPaise: number;
  receivedAt: string;
  riskCategory: string | null;
  action: string | null;
  channel: string | null;
  blocked: boolean;
  blockReason: string | null;
  actionStatus: string | null;
  recoveredPaise: number;
};

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedItem[]>([]);

  useEffect(() => {
    fetch("/api/feed").then((r) => r.json()).then((d) => setFeed(d.feed)).catch(() => setFeed([]));
  }, []);

  return (
    <div>
      <h1>Live Feed</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Most recent signals and what the pipeline decided + did for each.
      </p>

      {feed.length === 0 ? (
        <p style={{ color: "#888" }}>No events yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "1.5rem" }}>
          {feed.map((it) => (
            <div key={it.eventId} style={{ border: "1px solid #eee", borderRadius: "8px", padding: "0.8rem 1rem", background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <div>
                  <b>{it.eventType}</b>
                  {it.orderId ? ` · ${it.orderId}` : ""}
                </div>
                <div style={{ whiteSpace: "nowrap" }}>{inr.format(it.amountPaise)}</div>
              </div>
              <div style={{ display: "flex", gap: "1rem", marginTop: "0.4rem", fontSize: "0.85rem", color: "#555", flexWrap: "wrap" }}>
                <span>Risk: {it.riskCategory ?? "—"}</span>
                <span>
                  Action: <b>{it.action ?? "—"}</b>
                  {it.channel ? ` (${it.channel})` : ""}
                </span>
                {it.blocked ? (
                  <span style={{ color: "#dc2626" }}>Blocked — {it.blockReason}</span>
                ) : (
                  <span style={{ color: "#16a34a" }}>
                    {it.actionStatus === "success" ? "Executed" : it.actionStatus ?? "Authorized"}
                    {it.recoveredPaise > 0 ? ` · recovered ${inr.format(it.recoveredPaise)}` : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
